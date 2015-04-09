var events2 = require('eventemitter2');
var util = require('util');
var WS = require('ws');
var MSG = require('../api/AudioRouterClient.js');
var debug = require('debug')('audiorouterclient');
var dMetrics = require('debug')('audiorouterclient:metrics');
var BROWSER = false;

try {
  if(WebSocket) {
    BROWSER = true;
  }
} catch(e) {
  if(!(e instanceof ReferenceError)) {
    debug('Error detecting WebSocket'+e);
  }
}

var reconnectAttempts = 5;
var socketOpts = {binary: true, mask: true};

var AudioRouterClient = module.exports = function(options) {
  events2.EventEmitter2.call(this);
  var client = this;
  if(!options) {
    throw new Error('Cannot create AudioRouterClient. No options provided');
  }
  if(!options.wsUrlBinary) {
    throw new Error('Cannot create AudioRouterClient. No web socket URL provided');
  }
  if(!options.account) {
    throw new Error('Cannot create AudioRouterClient. No account provided');
  }
  if(!options.room) {
    throw new Error('Cannot create AudioRouterClient. No room provided');
  }
  if(!options.participant) {
    throw new Error('Cannot create AudioRouterClient. No participant provided');
  }
  if(!options.rate) {
    throw new Error('Cannot create AudioRouterClient. No rate provided');
  }
  debug('Creating AudioRouterClient instance',
    'Url:', options._wsUrlBinary,
    'Participant:', options.participant,
    'Account: ', options.account,
    'Room:', options.room);

  if(options.reconnect === undefined) {
    client._reconnect = true;
  }
  client._reconnect = options.reconnect;
  client._reconnectAttempts = options._reconnectAttempts || reconnectAttempts;
  client._wsUrlBinary = options.wsUrlBinary;
  client._account = options.account || null;
  client._room = options.room || null;
  client._participant = options.participant || null;
  client._rate = options.rate || null;
  client._metrics = {};
  client._metrics.PACKETS = 0;
  client._metrics.SAMPLES = 0;
  client._metrics.PACKETS_RX = 0;
  client._metrics.SAMPLES_RX = 0;
  if(options.debug) {
    client._debug = options.debug;
    client.metrics();
  }

  client.connect();
};
util.inherits(AudioRouterClient, events2.EventEmitter2);

AudioRouterClient.prototype.connect = function connect() {
  var client = this;
  debug('Connecting to server ' + client._wsUrlBinary);
  client._startMetrics();
  if(BROWSER) {
    client._ws = new WebSocket(client._wsUrlBinary, [
      'account.'+client._account,
      'room.'+client._room,
      'participant.'+client._participant
    ]);
    client._ws.binaryType = 'arraybuffer';
  }
  else {
    client._ws = new WS(client._wsUrlBinary, {
      headers: {
        account: client._account,
        room: client._room,
        participant: client._participant
      }
    });
  }

  client._setupEventHandlers();
};

AudioRouterClient.prototype.close = function close() {
  var client = this;
  debug('Closing connection, no reconnect');
  client._reconnect = false;
  client._ws.close();
  client.emit('closed');
};

AudioRouterClient.prototype.terminate = function terminate() {
  var client = this;
  debug('Terminating');
  client._stopMetrics();
  if(!BROWSER) {
    client._ws.terminate();
    client.emit('closed');
  }
};

AudioRouterClient.prototype._startMetrics = function _startMetrics() {
  var client = this;
  client._debug = true;

  client._metricsInterval = setInterval(function() {
    dMetrics('Audio Metrics',
      'Packets TX:', client._metrics.PACKETS,
      'TX Samples:', client._metrics.SAMPLES,
      'Packets RX', client._metrics.PACKETS_RX,
      'RX Samples:', client._metrics.SAMPLES_RX);
    client._metrics.PACKETS = 0;
    client._metrics.SAMPLES = 0;
    client._metrics.PACKETS_RX = 0;
    client._metrics.SAMPLES_RX = 0;

  }, 1000);
};

AudioRouterClient.prototype._stopMetrics = function _stopMetrics() {
  var client = this;
  if (client._metricsInterval) {
    clearTimeout(client._metricsInterval);
    client._metricsInterval = null;
  }
};

AudioRouterClient.prototype.sendAudio = function sendAudio(audioBuffer) {
  var client = this;

  var packet = client.createPacket(audioBuffer);
  if(client._debug) {
    client._metrics.PACKETS += 1;
    client._metrics.SAMPLES += audioBuffer.length;
  }

  if(client.connected) {
    if(BROWSER) {
      client._ws.send(packet);
    }
    else {
      client._ws.send(packet, socketOpts);
    }
  }
};

AudioRouterClient.prototype.createPacket = function createPacket(audioBuffer) {
  var client = this;

  var audioHeader = client.serializeAudioHeader(audioBuffer.length);
  audioHeader += '\n';

  var packet = new ArrayBuffer(audioHeader.length+audioBuffer.byteLength);

  var packetHeader = new DataView(packet, 0, audioHeader.length);
  for(var i=0; i<audioHeader.length; i++) {
    packetHeader.setInt8(i, audioHeader[i].charCodeAt(), true);
  }

  var packetAudio = new DataView(packet, audioHeader.length, audioBuffer.byteLength);
  for(var j=0; j<audioBuffer.length;j++) {
    packetAudio.setInt16(j*2, audioBuffer[j], true);
  }
  return packet;
};

AudioRouterClient.prototype.splitAudioPacket = function splitAudioPacket(buffer) {
  var packetOffset;

  var aBuff = new ArrayBuffer(buffer.length);
  var aView = new Int8Array(aBuff);

  for(var j=0; j<buffer.length; j++) {
    aView[j] = buffer[j];
    if(buffer[j] === 10) {
      packetOffset = j;
    }
  }

  aBuff = aBuff.slice(packetOffset+1);

  var packetAudio = new Int16Array(aBuff);

  return packetAudio;
};

AudioRouterClient.prototype.splitAudioPacketBrowser = function splitAudioPacketBrowser(buffer) {
  var packetAudio = [];

  var packet = new Uint8Array(buffer);
  for(var i=0; i<packet.length; i++) {
    if(packet[i] === 10) {
      packetAudio = buffer.slice(i+1);
      break;
    }
  }

  return packetAudio;
};

AudioRouterClient.prototype.serializeAudioHeader = function serializeAudioHeader(bufferLength) {
  var client = this;

  var audioHeader = {
    acnt: client._account,
    rm: client._room,
    ppt: client._participant,
    cnt: bufferLength,
    rate: client._rate
  };
  var serialized = JSON.stringify(audioHeader);

  return serialized;
};

AudioRouterClient.prototype._open = function _open() {
  var client = this;
  client.connected = true;
  delete client.reconnecting;
  client._reconnectAttempts = reconnectAttempts;
  client.emit(MSG.connected);
};

AudioRouterClient.prototype._closed = function _closed() {
  var client = this;
  client.connected = false;

  if(client._reconnect) {

    if(client.reconnecting) {
      if(client._reconnectAttempts > 0) {
        client._reconnectAttempts -= 1;
        delete client._ws;

        setTimeout(function() {
          client.connect();
        }, 1000);
      }
      else {
        client.emit(MSG.reconnectError);
      }
    }
    else {
      client.reconnecting = true;
      delete client._ws;
      setTimeout(function() {
        client.connect();
      }, 1000);
    }
  }
};

AudioRouterClient.prototype._error = function _error() {
  var client = this;
  client.connected = false;

  debug('AudioRouterClient Error');
};

AudioRouterClient.prototype._setupEventHandlers = function _setupEventHandlersProtoType() {
  var client = this;
  var audio = [];

  if(BROWSER) {
    client._ws.onmessage = function onmessage(msg) {
      if(msg) {
        client._metrics.PACKETS_RX++;
        audio = client.splitAudioPacketBrowser(msg.data);
        client._metrics.SAMPLES_RX += audio.byteLength / 2;
        client.emit(MSG.audioMessage, audio);
      }
      else {
        debug('Error: Did not not receive socket data');
      }
    };
    client._ws.onopen = client._open.bind(client);
    client._ws.onclose = client._closed.bind(client);
    client._ws.onerror = client._error.bind(client);
  }
  else {
    client._ws.on('message', function(data, flags) {
      if(data) {
        audio = client.splitAudioPacket(data);
        client.emit(MSG.audioMessage, audio);
      }
      else {
        debug('Error: Did not not receive socket data');
      }
    });
    client._ws.on('open', client._open.bind(client));
    client._ws.on('close', client._closed.bind(client));
    client._ws.on('error', client._error.bind(client));
  }
};
