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
    }
};

module.exports = WebSocketClient;
