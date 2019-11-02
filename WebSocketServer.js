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

        this._createLogger = this._createLogger.bind(this);
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
        httpServer.on('request', (req, res) => {
            if (req.url === '/healthcheck') {
                const address = httpServer.address();
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
        /**
         * TODO При получении сообщения от клиента - вынести отдельно
         * Тип должен быть utf8 (есть еще бинарный)
         */
        connection.on('message', (message) => {
            if (message.type === 'utf8') {
                this.logger.debug(`${this.constructor.name} Get from client ${connection.queryToken}: ${message.utf8Data}`);
                let json = JSON.parse(message.utf8Data);
                switch (json.action) {
                    case 'subscribe':
                        this._subscribeClient(connection, json.data);
                        break;
                    case 'unsubscribe':
                        this._unsubscribeClient(connection, json.data);
                        break;
                    default:
                        this.logger.warn(`Unknown action '${json.action}'`);
                        return;
                }
            }
        });

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
                // Перебираем все доступные стримы
                connection.availableStreams.forEach(availableStream => {
                    let name = this._getStreamName(availableStream);
                    // Если стрим с маской, получаем основу, перебираем запрашиваемые стримы.
                    // Если есть совпадение по имени, то для добавляем стримы для подписки в виде 'streamMaskBase_id'
                    if (name.endsWith('_*')) {
                        name = name.substr(0, name.length - 2);
                        requestStreams.forEach(requestStream => {
                            if (Array.isArray(requestStream) && requestStream.length === 2 && requestStream[0] === name) {
                                [].concat(requestStream[1]).forEach(id => {
                                    connection.streams = connection.streams.concat(requestStream[0] + '_' + id);
                                    return;
                                })
                            }
                        })
                    } else if (requestStreams.indexOf(name) !== -1) {
                        connection.streams = connection.streams.concat(availableStream)
                    }
                })
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
    async _unsubscribeClient(connection, streams) {
        // Если стримы не указаны, отписываеся от всех
        if (!streams) {
            streams = this._getStreamNames(connection.streams);
        }

        // Стримы для отписки
        let forUnsubscribe = [];
        // Из доступных стримов находим стримы с маской и перебираем их основы, если есть
        const maskeds = this._getMaskedStreamNames(connection.availableStreams);
        if (maskeds.length > 0) {
            maskeds.forEach(maskedName => {
                streams.forEach(stream => {
                    // Если есть совпадение c основанием маски
                    if (this._getStreamName(stream) === maskedName) {
                        // Если запрашиваемый стрим в виде ['stream', [ids...]], то все ids добавляем для отписки
                        if (Array.isArray(stream) && stream.length === 2) {
                            stream[1].forEach(id => {
                                forUnsubscribe.push(maskedName + '_' + id);
                            });
                        }
                    } else {
                        forUnsubscribe.push(this._getStreamName(stream));
                    }

                })
            })
        } else {
            forUnsubscribe = streams;
        }

        return Promise.all(
            forUnsubscribe.map(name => {
                if (this._subscribes[name]) {
                    this._subscribes[name]--;
                    // Удаляем из списка стримов клиента
                    connection.streams = connection.streams.filter(stream => this._getStreamName(stream) != name);
                    // Если подписчиков не осталось, удаляем из списка и отписываеся от редиса
                    if (this._subscribes[name] <= 0) {
                        delete this._subscribes[name];
                        return new Promise((resolve, reject) => {
                            this._redisSubClient.unsubscribe(this.redisNamespace + name, (err) => {
                                if (err) {
                                    this.logger.error(`${this.constructor.name} Error on unsubscribe from redis channel '${name}'.`);
                                    reject(err);
                                } else {
                                    this.logger.debug(`${this.constructor.name} Unsubscribe from redis channel '${name}'.`);
                                    resolve();
                                }
                            });
                        });
                    }
                }
            })
        )
    }

    _getStreamName(stream) {
        return Array.isArray(stream) ? stream[0] : stream;
    }

    _getStreamNames(streams) {
        return (streams || []).map(item => Array.isArray(item) ? item[0] : item);
    }

    _getMaskedStreamNames(availableStreams) {
        let masked = [];
        availableStreams.forEach(availableStream => {
            if (typeof availableStream === 'string' && availableStream.endsWith('_*')) {
                masked.push(availableStream.substr(0, availableStream.length - 2));
            }
        })

        return masked;
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
