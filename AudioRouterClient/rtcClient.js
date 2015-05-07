var events2 = require('eventemitter2');
var util = require('util');
var MSG = require('../api/AudioRouterClient.js');
var debug = require('debug')('yodlr:audiorouterclient:RTCClient');
var wrtc = require('wrtc');
var SimplePeer = require('simple-peer');

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

var RTCPeerConnection     = wrtc.RTCPeerConnection;
var RTCSessionDescription = wrtc.RTCSessionDescription;
var RTCIceCandidate       = wrtc.RTCIceCandidate;

var p2p = {
  RTCPeerConnection: RTCPeerConnection,
  RTCSessionDescription: RTCSessionDescription,
  RTCIceCandidate: RTCIceCandidate
};

var RTCClient = module.exports = function RTCClient(options) {
  events2.EventEmitter2.call(this);
  var client = this;

  if(!options) {
    throw new Error('Cannot create RTCClient. '
      + 'No options provided');
  }
  if(!options.account) {
    throw new Error('Cannot create RTCClient. '
    + 'No account provided');
  }
  if(!options.room) {
    throw new Error('Cannot create RTCClient. '
    + 'No room provided');
  }
  if(!options.participant) {
    throw new Error('Cannot create RTCClient. '
    + 'No participant provided');
  }
  if(!options.sock) {
    throw new Error('Cannot create RTCClient. '
    + 'No socket.io sock provided');
  }

  client._account = options.account;
  client._room = options.room;
  client._participant = options.participant;
  client._sock = options.sock;

  client._sock.on('signal', client._onSockSignal.bind(client));

  client._peer = new SimplePeer({initiator: true}, p2p);
  client._peer.on('signal', client._onPCSignal.bind(client));
  client._peer.on('connect', client._onConnect.bind(client));
  client._peer.on('data', client._onPeerData.bind(client));

  debug('Creating RTCClient instance',
    'Participant:', options.participant,
    'Account: ', options.account,
    'Room:', options.room);
};
util.inherits(RTCClient, events2.EventEmitter2);

RTCClient.prototype.send = function send(audio) {
  var client = this;
  if (client._peer) {
    client._peer.send(audio);
  }
};

RTCClient.prototype.close = function close() {
  var client = this;
  debug('Closing connection');
  if (client._peer) {
    client._peer.removeAllListeners();
    client._peer.destroy(function onClose() {
      debug('Peer connection destroyed');
      client._peer = null;
      client.emit('closed');
    });
  }
  else {
    debug('Peer connection already destroyed');
    client.emit('closed');
  }
  debug('Removing listener on signal event');
  client._sock.removeListener('signal', client._onSockSignal.bind(client));
};

// Private methods

RTCClient.prototype._onConnect = function _onConnect() {
  var client = this;
  debug('we are connected');
  client.emit(MSG.connected);
};

RTCClient.prototype._onPCSignal = function _onPCSignal(data) {
  var client = this;
  debug('Local signal data', data);
  if (client._sock) {
    client._sock.emit('signal', data);
  }
};

RTCClient.prototype._onPeerData = function _onPeerData(data) {
  var client = this;
  if (BROWSER) {
    data = data.toArrayBuffer();
  }
  client.emit('audio', data);
};

RTCClient.prototype._onSockSignal = function _onSockSignal(data) {
  var client = this;
  debug('Signal received', data);
  if (client._peer) {
    client._peer.signal(data);
  }
};
