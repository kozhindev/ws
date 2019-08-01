const winston = require('winston');
const redis = require('redis');
const http = require('http');
const webSocketServer = require('websocket').server;

module.exports = class WebSocketServer {

    constructor(params) {
        params = params || {};

        this.port = params.port || 1400;
        this.redisNamespace = params.redisNamespace || '';
        this.redisConfig = params.redisConfig || {};
        this.logger = this._createLogger(params.logger);

        this._wsServer = null;
        this._subscribes = {};

        this._onRequest = this._onRequest.bind(this);
        this._onRedisMessage = this._onRedisMessage.bind(this);

        this.REDIS_KEY_WS_TOKENS = 'tokens';
        this.REDIS_EVENT_TOKENS_UPDATE = 'tokens_update';
        this.REASON_CODE_UNAUTHORIZED = 4401;
    }

    start() {
        // Create HTTP server
        const httpServer = http.createServer();
        httpServer.listen(this.port, () => this.logger.info(`${this.constructor.name} is listening on port ${this.port}...`));
        httpWs.on('request', (req, res) => {
            if (req.url === '/healthcheck') {
                const address = httpWs.address();
                res.writeHead(address ? 200 : 500, {
                    'Content-Type': 'text/plain'
                });
                res.write(JSON.stringify({
                    ...address,
                    connections: this._wsServer.connections.length,
                }));
                res.end('\n');
            }
        });

        // Create WS server
        this._wsServer = new webSocketServer({
            httpServer,
        });

        // Create redis connection
        this._redisClient = redis.createClient(this.redisConfig);

        // Create redis connection
        this._redisSubClient = redis.createClient(this.redisConfig);
        this._redisSubClient.on('message', this._onRedisMessage);
        this._redisSubClient.subscribe(this.redisNamespace + this.REDIS_EVENT_TOKENS_UPDATE);

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
        connection.queryToken = request.resourceURL.query.token;
        connection.queryStreams = (request.resourceURL.query.streams || '').split(',').filter(Boolean);

        // Log client connected
        this.logger.debug(`${this.constructor.name} user '${connection.remoteAddresses.join(', ')}' connected, token: ${connection.queryToken}`);

        this._refreshAvailableStreams(connection);

        // Unsubscribe redis on disconnect
        //connection.on('close', () => this._unsubscribeClient(connection));
    }

    /**
     * @param {object} connection
     * @param {string[]|array} requestStreams
     * @private
     */
    async _subscribeClient(connection, requestStreams) {
        // Unsubscribe previous
        //await this._unsubscribeClient(connection);

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
    async _unsubscribeClient(connection) {
        return Promise.all(
            this._getStreamNames(connection.streams).map(name => {
                if (this._subscribes[name]) {
                    this._subscribes[name]--;
                    if (this._subscribes[name] <= 0) {
                        delete this._subscribes[name];
                    }

                    return new Promise((resolve, reject) => {
                        this._redisSubClient.unsubscribe(this.redisNamespace + name, function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    });
                }
            })
        )
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

        if (stream === this.REDIS_EVENT_TOKENS_UPDATE) {
            const tokens = JSON.parse(message);
            this._wsServer.connections.forEach(connection => {
                if (tokens.includes(connection.queryToken)) {
                    this._refreshAvailableStreams(connection);
                }
            });
        } else {
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

                if (!Array.isArray(userStream) || [].concat(userStream[1]).indexOf(data.id) !== -1) {
                    connection.send(message);
                    subscribersCount++;
                }
            });

            this.logger.debug(`${this.constructor.name} Send to stream '${stream}' (${this._wsServer.connections.length} connections, ${subscribersCount} subscribers): ${message}`);
        }
    }

    async _refreshAvailableStreams(connection) {
        const availableStreams = await this._getAvailableStreams(connection.queryToken);
        if (!availableStreams) {
            this.logger.warn(`${this.constructor.name} Not found token '${connection.queryToken}' for connection '${connection.remoteAddresses.join(', ')}`);
            connection.close(this.REASON_CODE_UNAUTHORIZED, 'Authorization failed, please refresh token.');
        } else {
            // Subscribe on streams
            connection.availableStreams = availableStreams;
            this._subscribeClient(connection, connection.queryStreams);
        }
    }

    /**
     *
     * @param token
     * @returns {Promise<unknown>}
     * @private
     */
    _getAvailableStreams(token) {
        return new Promise((resolve, reject) => {
            this._redisClient.get(this.redisNamespace + this.REDIS_KEY_WS_TOKENS + ':' + token, (err, reply) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(reply ? JSON.parse(reply) : null);
                }
            });
        });
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
