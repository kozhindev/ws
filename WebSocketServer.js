const winston = require('winston');
const redis = require('redis');
const http = require('http');
const webSocketServer = require('websocket').server;

module.exports = class WebSocketServer {

    constructor(params) {
        params = params || {};

        this.port = params.port || 1400;
        this.redisNamespace = params.redisNamespace || '';
        this.logger = this._createLogger(params.logger);

        this._wsServer = null;
        this._subscribes = {};

        this._onRequest = this._onRequest.bind(this);
        this._onRedisMessage = this._onRedisMessage.bind(this);

        this.REDIS_KEY_WS_TOKENS = 'tokens';
        this.REASON_CODE_UNAUTHORIZED = 4401;
    }

    start() {
        // Create HTTP server
        const httpServer = http.createServer();
        httpServer.listen(this.port, () => this.logger.info(`${this.constructor.name} is listening on port ${this.port}...`));

        // Create WS server
        this._wsServer = new webSocketServer({
            httpServer,
        });

        // Create redis connection
        this._redisClient = redis.createClient();

        // Create redis connection
        this._redisSubClient = redis.createClient();
        this._redisSubClient.on('message', this._onRedisMessage);

        // Listen requests
        this._wsServer.on('request', this._onRequest);
    }

    stop() {
        if (this._redisClient) {
            this._redisClient.quit();
        }
        if (this._redisSubClient) {
            this._redisSubClient.quit();
        }
        if (this._wsServer) {
            this._wsServer.shutDown();
        }
    }

    /**
     * @param {object} request
     * @private
     */
    _onRequest(request) {
        const connection = request.accept(null, request.origin);
        const token = request.resourceURL.query.token;
        const streams = (request.resourceURL.query.streams || '').split(',').filter(Boolean);

        // Log client connected
        this.logger.debug(`${this.constructor.name} user '${connection.remoteAddresses.join(', ')}' connected, token: ${token}`);

        // Fetch access
        this._redisClient.get(this.redisNamespace + this.REDIS_KEY_WS_TOKENS + ':' + token, (err, reply) => {
            if (err) {
                this.logger.error(err);
                return;
            }

            if (!reply) {
                this.logger.warn(`${this.constructor.name} Not found token '${token}' for connection '${connection.remoteAddresses.join(', ')}`);
                connection.close(this.REASON_CODE_UNAUTHORIZED, 'Authorization failed, please refresh token.');
                return;
            }

            // Subscribe on streams
            connection.availableStreams = JSON.parse(reply);
            this._subscribeClient(connection, streams);

            // Unsubscribe redis on disconnect
            connection.on('close', () => this._unsubscribeClient(connection));
        });
    }

    /**
     * @param {object} connection
     * @private
     */
    _subscribeClient(connection, requestStreams) {
        // Unsubscribe previous
        this._unsubscribeClient(connection);

        // Filter requested streams
        connection.streams = [];
        if (connection.availableStreams.length > 0) {
            if (requestStreams.indexOf('*') !== -1) {
                // Listen all of available
                connection.streams = connection.availableStreams;
            } else {
                connection.streams = connection.availableStreams.filter(availableStream => {
                    const name = Array.isArray(availableStream) ? availableStream[0] : availableStream;
                    return requestStreams.indexOf(name) !== -1;
                });
            }
        }

        // Subscribe on redis
        this._getStreamNames(connection.streams).forEach(name => {
            if (!this._subscribes[name]) {
                this._subscribes[name] = 1;
                this._redisSubClient.subscribe(this.redisNamespace + name);
                this.logger.debug(`${this.constructor.name} Subscribed to redis channel '${name}'.`);
            } else {
                this._subscribes[name]++;
            }
        });
    }

    /**
     * @param {object} connection
     * @private
     */
    _unsubscribeClient(connection) {
        this._getStreamNames(connection.streams).forEach(name => {
            if (this._subscribes[name]) {
                this._subscribes[name]--;
                this._redisSubClient.unsubscribe(this.redisNamespace + name);

                if (this._subscribes[name] <= 0) {
                    delete this._subscribes[name];
                }
            }
        });
    }

    _getStreamNames(streams) {
        return (streams || []).map(item => Array.isArray(item) ? item[0] : item);
    }

    /**
     * @param {string} stream
     * @param {string} message
     * @private
     */
    _onRedisMessage(stream, message) {
        stream = stream.substr(this.redisNamespace.length);

        const data = JSON.parse(message);

        let subscribersCount = 0;
        this._wsServer.connections.forEach(connection => {
            const userStream = connection.streams.find(item => {
                const name = Array.isArray(item) ? item[0] : item;
                return name === stream;
            });
            if (!userStream) {
                return;
            }

            if (!Array.isArray(userStream) || userStream[1].indexOf(data.id) !== -1) {
                connection.send(message);
                subscribersCount++;
            }
        });

        this.logger.debug(`${this.constructor.name} Send to stream '${stream}' (${this._wsServer.connections.length} connections, ${subscribersCount} subscribers): ${message}`);
    }

    /**
     * @param {object} params
     * @returns {*}
     * @private
     */
    _createLogger(params) {
        return winston.createLogger(Object.assign(
            {
                format: winston.format.combine(
                    winston.format.timestamp(),
                    winston.format.colorize(),
                    winston.format.printf(info => `${info.timestamp} ${info.level} ${info.message}`)
                ),
                transports: [
                    new winston.transports.Console(),
                ],
                level: 'info',
            },
            params
        ));
    }

};
