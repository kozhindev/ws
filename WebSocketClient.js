const WebSocketClient = function (params) {
    params = params || {};

    this.wsUrl = params.wsUrl || null;
    this.streams = params.streams || ['*'];
    this.authHandler = params.authHandler || null;
    this.onOpen = params.onOpen || null;
    this.onClose = params.onClose || null;
    this.onMessage = params.onMessage || null;

    this._connection = null;
    this._tryCount = null;

    this._queueToSubscribe = [];

    this._authToken = null;
    this._connect = this._connect.bind(this);
    this._onOpen = this._onOpen.bind(this);
    this._onMessage = this._onMessage.bind(this);
    this._onClose = this._onClose.bind(this);

    this.REASON_CODE_UNAUTHORIZED = 4401;
};

WebSocketClient.prototype = {

    open: function () {
        // Close previous
        this.close();

        this._connect();
    },

    close: function () {
        if (this._connection) {
            this._connection.close();
        }
    },

    subscribeStream: function (stream, id) {
        id
            ? this.subscribe([[stream, [id]]])
            : this.subscribe([stream])
    },

    subscribe: function (streams) {
        streams = [].concat(streams);

        // Стримы для подписки
        let forSubscribe = [];
        streams.forEach(stream => {
            // Если стримов нет, то сразу добавляем
            if (this.streams.length === 0) {
                this.streams.push(stream);
                forSubscribe.push(stream);
                return;
            }

            const name = this._getStreamName(stream);
            // Перебираем текущие стримы
            this.streams.forEach((clientStream, index, clientStreams)  => {
                // Если текущий стрим и запрашиваемый вида [streamName, [ids...]]
                // то из запрашиваемых id выбираем те, на которые не подписаны,
                // формируем новый стрим с нужными id, добавляем с список для дальнейшей подписки
                if (this._getStreamName(clientStream) === name && Array.isArray(clientStream) && Array.isArray(stream)) {
                    const idsForSubscribe = stream[1].filter(id => !clientStream.includes(id));
                    forSubscribe.push([name, idsForSubscribe]);
                    // К текущим стримам добавлем недостающие id
                    clientStreams[index][1] = clientStreams[index][1].concat(idsForSubscribe);
                } else {
                    forSubscribe.push(stream);
                }
            });
        })

        // Если есть стримы, на которые нужно подписаться
        if (forSubscribe.length > 0) {
            // Если нет соединения или в процессе подключения, добавляем в очередь
            if (!this._connection || !this._connection.readyState) {
                this._queueToSubscribe = this._queueToSubscribe.concat(forSubscribe);
                return;
            }
            // Шлем запрос на подписку
            this.sendSubscribeRequest(forSubscribe);
        }
    },

    sendSubscribeRequest: function (streams) {
        this._connection.send(JSON.stringify({
            action: 'subscribe',
            data: streams,
        }));
    },

    unsubscribeStream: function (stream, id) {
        id
            ? this.unsubscribe([[stream, [id]]])
            : this.unsubscribe([stream])
    },

    unsubscribe: function (streams) {
        if (!this._connection || this.streams.length === 0) {
            return;
        }
        streams = [].concat(streams);

        // Стримы для отписки
        let forUnsubscribe = [];
        this.streams.forEach((clientStream, index, clientStreams) => {
            const name = this._getStreamName(clientStream);
            streams.forEach(stream => {
                if (this._getStreamName(stream) === name) {
                    // Если подписаны на стрим вида 'stream', а запрос на отписку виду ['stream', [ids...]], ничего не делаем
                    if (typeof clientStream === 'string' && Array.isArray(stream)) {
                        return;
                    }

                    // Если обычный стрим, добавляем в список для отписки и удаляем из своего списка
                    if (typeof stream === 'string') {
                        forUnsubscribe.push(clientStream);
                        clientStreams.splice(index, 1);

                        // Если стримы вида ['stream', [ids...]], находим из запрашиваемых выбираем ids, на которые уже подписаны
                        // Формируем новый стрим и добавляем в список для дальнейшей отписки
                        // Удаляем эти ids из текущего списка
                    } else if (Array.isArray(stream) && Array.isArray(clientStream)) {
                        const idsForUnsubscribe = stream[1].filter(streamId => clientStream[1].includes(streamId));
                        forUnsubscribe.push([name, idsForUnsubscribe]);
                        clientStreams[index][1] = clientStreams[index][1].filter(id => !idsForUnsubscribe.includes(id));
                        // Если удалили все ids, то удаляем стрим целиком
                        if (clientStreams[index][1].length === 0) {
                            clientStreams.splice(index, 1);
                        }
                    }
                }
            });
        });

        // Если есть стримы, от которых нужно отписаться, шлем серверу
        if (forUnsubscribe.length > 0) {
            this._connection.send(JSON.stringify({
                action: 'unsubscribe',
                data: forUnsubscribe,
            }));
        }
    },

    _connect: function () {
        if (!this._authToken) {
            this.authHandler(function (token) {
                if (token) {
                    this._authToken = token;
                    this._connect();
                }
            }.bind(this));
        } else if (this.streams) {
            this._connection = new WebSocket(this.wsUrl + '?streams=' + this.streams.join(',') + '&token=' + this._authToken);
            this._connection.onopen = this._onOpen;
            this._connection.onmessage = this._onMessage;
            this._connection.onclose = this._onClose;
        }
    },

    _reConnect: function () {
        let delay = 1000;
        if (this._tryCount > 10) {
            delay = 2000;
        }
        if (this._tryCount > 50) {
            delay = 5000;
        }
        if (this._tryCount > 100) {
            delay = 15000;
        }

        this._tryCount++;
        setTimeout(this._connect, delay);
    },

    _onOpen: function () {
        this._tryCount = 0;

        // Если был запрос на подписку, подписываемся
        if (this._queueToSubscribe.length > 0) {
            this.sendSubscribeRequest(this._queueToSubscribe)
        }

        if (this.onOpen) {
            this.onOpen();
        }
    },

    _onMessage: function (message) {
        if (this.onMessage) {
            this.onMessage(JSON.parse(message.data));
        }
    },

    _onClose: function (event) {
        if (this.onClose) {
            this.onClose(event);
        }

        if (event.code === this.REASON_CODE_UNAUTHORIZED) {
            this._authToken = null;
        }
        this._reConnect();
    },

    _getStreamName(stream) {
        return Array.isArray(stream) ? stream[0] : stream;
    }
};

module.exports = WebSocketClient;
