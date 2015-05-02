var WS = require('ws');
var events2 = require('eventemitter2');
var util = require('util');
var MSG = require('../api/AudioRouterClient.js');
var debug = require('debug')('yodlr:audiorouterclient:wsclient');

var reconnectAttempts = 5;
var socketOpts = {binary: true, mask: true, compress: false};

var BROWSER = false;

try {
  if(WebSocket) {
    BROWSER = true;
  }
} catch(e) {
  if(!(e instanceof ReferenceError)) {
    debug('Error detecting WebSocket' + e);
  }
}

var WSClient = module.exports = function WSClient(options) {
  events2.EventEmitter2.call(this);
  var client = this;

  if(!options) {
    throw new Error('Cannot create WSClient. '
      + 'No options provided');
  }
  if(!options.wsUrlBinary) {
    throw new Error('Cannot create WSClient. '
      + 'No web socket URL provided');
  }
  if(!options.account) {
    throw new Error('Cannot create WSClient. '
    + 'No account provided');
  }
  if(!options.room) {
    throw new Error('Cannot create WSClient. '
    + 'No room provided');
  }
  if(!options.participant) {
    throw new Error('Cannot create WSClient. '
    + 'No participant provided');
  }

  client._wsUrlBinary = options.wsUrlBinary;
  client._account = options.account;
  client._room = options.room;
  client._participant = options.participant;

  debug('Creating WSClient instance',
    'Url:', options.wsUrlBinary,
    'Participant:', options.participant,
    'Account: ', options.account,
    'Room:', options.room);

  if(BROWSER) {
    debug('Creating WebSocket');
    client._ws = new WebSocket(client._wsUrlBinary + '/audio', [
      'account.'+client._account,
      'room.'+client._room,
      'participant.'+client._participant
    ]);
    client._ws.binaryType = 'arraybuffer';
  }
  else {
    debug('Creating WS client');
    client._ws = new WS(client._wsUrlBinary + '/audio', {
      headers: {
        account: client._account,
        room: client._room,
        participant: client._participant
      }
    });
  }

  client._setupEventHandlers();
};
util.inherits(WSClient, events2.EventEmitter2);

WSClient.prototype._setupEventHandlers = function _setupEventHandlersProtoType() {
  var client = this;
  var audio = [];

  if(BROWSER) {
    client._ws.onmessage = function onmessage(msg) {
      if(msg) {
        client.emit('audio', msg.data);
      }
      else {
        debug('Error: Did not not receive socket data');
      }
    };
    client._ws.onopen = client._wsopen.bind(client);
    client._ws.onclose = client._wsclosed.bind(client);
    client._ws.onerror = client._wserror.bind(client);
  }
  else {
    client._ws.on('message', function(data, flags) {
      if(data) {
        client.emit('audio', data);
      }
      else {
        debug('Error: Did not not receive socket data');
      }
    });
    client._ws.on('open', client._wsopen.bind(client));
    client._ws.on('close', client._wsclosed.bind(client));
    client._ws.on('error', client._wserror.bind(client));
  }
};

WSClient.prototype.send = function send(audio) {
  var client = this;
  if (client.wsConnected) {
    client._ws.send(audio, socketOpts);
  }
}

WSClient.prototype._wsopen = function _wsopen() {
  var client = this;
  client.wsConnected = true;
  debug('Websocket open');
  delete client.wsReconnecting;
  client._reconnectAttempts = reconnectAttempts;
  client.emit(MSG.connected);
}

WSClient.prototype._wsclosed = function _wsclosed() {
  var client = this;
  client.wsConnected = false;
  debug('Websocket closed');

  if(client._reconnect) {
    if(client.wsReconnecting) {
      if(client._reconnectAttempts > 0) {
        client._reconnectAttempts -= 1;
        delete client._ws;

        setTimeout(function() {
          client.connect(); // TODO
        }, 1000);
      }
      else {
        client.emit(MSG.reconnectError);
      }
    }
    else {
      client.wsReconnecting = true;
      delete client._ws;
      setTimeout(function() {
        client.connect(); // TODO
      }, 1000);
    }
  }
};

WSClient.prototype.close = function close() {
  var client = this;
  debug('Closing connection, no reconnect');
  if (client._ws) {
    client._ws.close();
  }
  client.emit('closed');
};

WSClient.prototype._wserror = function _wserror() {
  var client = this;
  client.connected = false;

  debug('Websocket error');
};
