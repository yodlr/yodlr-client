var events2 = require('eventemitter2');
var request = require('browser-request');
var io = require('socket.io-client');
var util = require('util');
var MSG = require('./api');
var YRoom = require('./YodlrClientRoom.js');
var AudioClient = require('./AudioClient.js');
var Metric = require('./YodlrMetric');
var SoundEffectMgr = require('sound-effect-manager');
var sm = new SoundEffectMgr();
sm.loadFile('/sounds/test_sound.mp3', 'sound_test');
var WebrtcSources = require('webrtc-sources');
require('browsernizr/test/websockets');
require('browsernizr/test/webrtc/getusermedia');
var modernizr = require('browsernizr');
var configPath;
var debug = require('debug')('yodlr:client');
var latencyDebug = require('debug')('yodlr:client:latency');
window.debug = require('debug');

/**
 * Initializes a YodlrClient object
 * @constructor
 * @param {object} [options] Options for YodlrClient.
 * @param {string} [options.name] The name of the YodlrClient user, defaults to random GuestXXX name
 * @param {string} [options.url] The URL to which YodlrClient connects, defaults to https://getyodlr.com
 * @param {number} [options.port] The port to which YodlrClient connects, defaults to port 443
 * @param {string} [options.host] The URL to which the audio connects, defaults to https://getyodlr.com
 * @param {boolean} [options.debug] Enable debug logging
 * @emits YodlrClient#browserReqs
 * @emits YodlrClient#connected
 * @emits YodlrClient#disconnected
 * @emits YodlrClient#joinError
 * @emits YodlrClient#mediaAllowed
 * @emits YodlrClient#ready
 * @emits YodlrClient#yodlrError
 * @emits YodlrClient#thisUserChanged
 * @emits YodlrClient#unsupportedBrowser
 * @returns {YodlrClient}
 * @example
 * var Yodlr = require('YodlrClient');
 * var sClient = new Yodlr();
 */

var YodlrClient = module.exports = function YodlrClient(options) {
  events2.EventEmitter2.call(this);
  if (!options) {
    options = {};
  }

  var spk = this;
  spk._setupMicSelect();

  spk.name = options.name;
  spk.user = null;
  spk.loaded = false;
  spk.audio = {};
  spk.unsupportedBrowser = 0;
  spk.mobileBrowser = 0;

  configPath = 'https://getyodlr.com';

  if (options.url !== undefined && options.port !== undefined) {
    configPath = options.url + ':' + options.port;
  }

  var userAgent = window.navigator.userAgent;
  var supportedBrowsers = new RegExp('(chrome|firefox)', 'i');
  var filter = new RegExp('mobile|Nexus', 'i');

  if (filter.test(userAgent)) {
    spk.mobileBrowser = 1;
  }
  if (supportedBrowsers.test(userAgent)) {
    spk.unsupportedBrowser = 0;
  }
  else {
    spk.unsupportedBrowser = 1;
  }
  setTimeout(function errorTimeout() {
    if(spk.mobileBrowser === 1) {
      debug('unsupportedBrowser: mobile');
      spk.emit('unsupportedBrowser', [{name: 'mobile', url: 'not supported'}]);
    }
    else if(spk.unsupportedBrowser === 1) {
      debug('unsupportedBrowser: non-Chrome');
      spk.emit('unsupportedBrowser', [
        {
          name: 'Google Chrome',
          url: 'http://www.google.com/chrome/browser/'
        },
        {
          name: 'Mozilla Firefox',
          url: 'http://www.firefox.com/'
        }
      ]);
    }
  }, 0);

  request(configPath + '/api/config', function configReqResp(err, res, body) {
    if (err) {
      throw new Error('Unable to load app config ' + err);
    }

    var browserReqs = {
      websockets: modernizr.websockets,
      getusermedia: modernizr.getusermedia
    };
    spk._reqsMet = browserReqs.websockets && browserReqs.getusermedia;
    spk.emit(MSG.browserReqs, browserReqs);

    spk._config = JSON.parse(body);
    spk.loaded = true;
    spk.rooms = {};
    debug('config received: ', spk._config);
    if (spk._config.env !== 'dev' && options.url !== undefined) {
      spk._config.httpUrl = options.url + ':' + options.port;
      spk._config.httpPort = options.port;
      spk._config.audioUrl = spk._config.audioUrl;
    }
    spk._socketioPort = spk._config.socketioPort;
    spk._url = spk._config.socketio;
    spk._audioUrl = spk._config.audioUrl;
    if (!spk.unsupportedBrowser && !spk.mobileBrowser) {
      debug('Emitting \'ready\' event');
      spk.emit('ready');
    }
  });
};
util.inherits(YodlrClient, events2.EventEmitter2);

/**
 * Connects to the Yodlr Server
 * @method
 * @emits YodlrClient#connected
 * @emits YodlrClient#mediaAllowed
 * @example
 * var sClient = new Yodlr();
 * sClient.on('ready', function() {
 *  sClient.connect();
 * });
 */

YodlrClient.prototype.connect = function connect() {
  var spk = this;
  if (spk._connecting || (spk.sock && spk.sock.connected)) {
    return debug('Already connected/connecting, will not restart');
  }
  spk._connecting = true;
  debug('Attempting to connect to ', spk._url, spk._config.socketioPort);

  spk.sock = io.connect(spk._url, {'force new connection': true,
                                  'transports': ['websocket'],
                                  'port': spk._config.socketioPort});
  spk.sock.on('error', function onSocketError(err) {
    debug('Socket.io error: ', err);
  });
  spk.sock.on('connect', function onSocketConnect() {
    spk._connecting = false;
    debug('Connected to server', spk._url);
    spk.emit('connected');
    if (spk.name !== undefined) {
      spk.setThisUserName(spk.name);
    }

    // handle reconnection
    spk._reconnect();
  });
  spk.sock.on('disconnect', function onSocketDisconnect() {
    debug('Disconnected from server');
    spk._disconnected = true;
    spk.emit(MSG.disconnected);
    if (spk.audio && spk.audio.client) {
      spk.audio.client.disconnect();
    }
  });

  spk.metric = new Metric(spk.sock);

  spk._setupEventHandlers();
};

/**
 * Disconnects from the Yodlr Server
 * @method
 * @emits YodlrClient#disconnected
 * @throws 'YodlrClient has not been loaded'
 * @example
 * var sClient = new Yodlr();
 * sClient.on('ready', function() {
 *  sClient.disconnect();
 * });
 */

YodlrClient.prototype.disconnect = function disconnect() {
  if (!this.loaded) {
    throw new Error('YodlrClient has not been loaded');
  }
  debug('Disconnecting from server');
  this.sock.disconnect();
  if (this.audio && this.audio.client) {
    this.audio.client.disconnect();
  }
};

/**
 * Gets this clients user name
 * @method
 * @returns {string} user name
 * @example
 * var myUserName = sClient.getThisUserName;
 */

YodlrClient.prototype.getThisUserName = function getThisUserName() {
  return this.name;
};

/**
 * Joins a Yodlr room
 * @method
 * @param {object} data Options for YodlrClient.
 * @param {string} data.room The name of the Yodlr room
 * @param {string} data.apiKey The api key to create Yodlr room (required for creating a room)
 * @param {string} data.email The email account (required for creating a room)
 * @returns {YodlrClientRoom}
 * @emits YodlrClientRoom#joinedRoom
 * @emits YodlrClient#thisUserChanged
 * @emits YodlrClient#joinError
 * @emits YodlrClient#yodlrError
 * @throws '[api.joinRoom] No room object provided'
 * @throws '[api.joinRoom] No room name provided'
 * @throws 'YodlrClient has not been loaded'
 * @example
 * var sClient = new Yodlr();
 * var YRoom;
 * sClient.on('ready', function() {
 *  YRoom = sClient.joinRoom({room: 'example', apiKey: 'myApiKey', email: 'myEmail@mail.com'});
 *  YRoom.on('joinedRoom', function(
 *    console.log('I am in the room!');
 *  ));
 * });
 */

YodlrClient.prototype.joinRoom = function joinRoom(data) {
  if (!data) {
    throw new Error('[api.joinRoom] No room object provided');
  }
  if (!data.room) {
    throw new Error('[api.joinRoom] No room name provided');
  }
  if (!this.loaded) {
    throw new Error('YodlrClient has not been loaded');
  }

  var spk = this;

  data.room = data.room.toLowerCase();
  var config = {
    socket: this.sock || {},
    name: data.room,
    config: this._config,
    audio: this.audio
  };
  var spkRoom = new YRoom(config);

  spk._joinRoom(spkRoom, data);

  return spkRoom;
};

/**
 * Leave a Yodlr room
 * @method
 * @param {string} roomName - Name of the room to leave
 * @emits YodlrClientRoom#leftRoom
 * @emits YodlrClient#thisUserChanged
 * @emits YodlrClient#yodlrError
 * @throws 'YodlrClient has not been loaded'
 * @example
 * var sClient = new Yodlr();
 * var YRoom;
 * sClient.on('ready', function() {
 *  YRoom = sClient.joinRoom({room: 'example', keycode: 'myKeycode'});
 *  YRoom.on('joinedRoom', function(
 *    sClient.leaveRoom('example');
 *  ));
 * });
 */

YodlrClient.prototype.leaveRoom = function leaveRoom(roomName) {
  if (!roomName) {
    return this.emit(MSG.error,
      new Error('[api.leaveRoom] No room name provided'));
  }
  if (!this.loaded) {
    throw new Error('YodlrClient has not been loaded');
  }
  if (this.audio && this.audio.client) {
    this.audio.client.setMicEnable(false);
  }
  roomName = roomName.toLowerCase();
  debug('Leaving room ', roomName);
  this._send(MSG.leaveRoom, {room: roomName});
};

/**
 * Change YodlrClient users name
 * @method
 * @param {string} thisUserName - New name for the user
 * @emits YodlrClient#thisUserChanged
 * @emits YodlrClient#yodlrError
 * @throws 'YodlrClient has not been loaded'
 * @example
 * sClient.setThisUserName('myNewUserName');
 * sClient.on('thisUserChanged', function() {
 *  console.log('I have changed my name!');
 * });
 */

YodlrClient.prototype.setThisUserName = function setThisUserName(thisUserName) {
  if (!thisUserName) {
    return this.emit(MSG.error,
      new Error('[api.setThisUserName] No name provided'));
  }
  if (!this.loaded) {
    throw new Error('YodlrClient has not been loaded');
  }
  else {
    this.name = thisUserName;
    debug('Setting name to ' + this.name);
    this._send(MSG.setThisUserName, {name: thisUserName});
  }
};

YodlrClient.prototype._setupMicSelect = function _setupMicSelect() {
  var spk = this;
  spk.micselect = new WebrtcSources();
  spk.micselect.on('audioSources', function onAudioSources(as) {
    spk.emit('audioSources', as);
  });
  spk.micselect.on('volume', function onVolume(vol) {
    spk.emit('volumeLevel', vol);
  });
  spk.micselect.on('error', function onMicSelectErr(err) {
    spk.emit('error', err);
  });
  spk.micselect.on('speaking', function onSpeaking() {
    spk.emit('speaking');
  });
  spk.micselect.on('stopped_speaking', function onStoppedSpeaking() {
    spk.emit('stopped_speaking');
  });
  spk.micselect.on('mediaStream', function onMediaStream(err) {
    spk.emit('mediaStream', err);
  });
};

// TODO: Document these new APIs
YodlrClient.prototype.setEmitVol = function setEmitVol(value) {
  var spk = this;
  spk.micselect.setEmitVol(value);
};

YodlrClient.prototype.getMics = function getMics() {
  var spk = this;
  spk.micselect.getMics();
};

YodlrClient.prototype.setMic = function setMic(mic) {
  var spk = this;
  spk.micselect.setMic(mic);
  spk._selectedMic = mic;
  if (spk.audio && spk.audio.client && spk.audio.client.started) {
    spk.audio.client.changeMicrophone(mic);
  }
};

YodlrClient.prototype.playTestSound = function playTestSound() {
  sm.play('sound_test');
};

YodlrClient.prototype._errorHandler = function _errorHandler(data) {
  debug('Error received [' +
    MSG.error + ']: ', data);
  this.emit(MSG.error, data);
};

YodlrClient.prototype._joinRoom = function _joinRoom(spkRoom, data) {
  this.connect();

  this.rooms[data.room] = spkRoom;
  this.rooms[data.room].sock = this.sock;
  this._send(MSG.joinRoom, data);
};

YodlrClient.prototype._joinedRoom = function _joinedRoom(data) {
  this._setupAudioClient(data);
  this.joinedRoom = data.room;
  this.rooms[data.room]._joinedRoom(data);
};

YodlrClient.prototype._joinErrorHandler = function _joinErrorHandler(data) {
  debug('JoinError', data);
  if (data.error && data.error.indexOf('Key not found') >= 0) {
    // mxr could not be found
    this.disconnect();
  }
  else {
    this.emit(MSG.joinError, data);
  }
};

YodlrClient.prototype._kill = function _kill(data) {
  debug('Received \'kill\' command');
  this.disconnect();
};

YodlrClient.prototype._leftRoom = function _leftRoom(data) {
  this.rooms[data.room]._leftRoom(data);
  var room = this.rooms[data.room];
  room.removeAllListeners();
  delete room.sock;
  delete this.rooms[data.room];
};

YodlrClient.prototype._sendPing = function _sendPing() {
  var timeStart = Date.now();
  this.sock.emit(MSG.ping, {timeStart: timeStart});
};

YodlrClient.prototype._ping = function _ping(data) {
   this.sock.emit(MSG.pong, data);
 };

YodlrClient.prototype._pong = function _pong(data) {
  var timeEnd = Date.now();
  var latency = timeEnd - data.timeStart;
  latencyDebug('Latency to server: ' + latency);
  this.emit('latency', latency);
};

YodlrClient.prototype._receiveChatMessage = function _receiveChatMessage(data) {
  this.rooms[data.room]._receiveChatMessage(data);
};

YodlrClient.prototype._receiveFileMessage = function _receiveFileMessage(data) {
  this.rooms[data.room]._receiveFileMessage(data);
};

YodlrClient.prototype._receiveMessage = function _receiveMessage(data) {
  this.rooms[data.room.name]._receiveMessage(data);
};

YodlrClient.prototype._reconnect = function _reconnect() {
  if (this._disconnected) {
    this._disconnected = false;
    this.emit(MSG.reconnected);
  }
};

YodlrClient.prototype._send = function _send(type, data) {
  if (this.sock) { // TODO: improve this to make sure we're connected?
    debug('Sending message ' + '[' + type + ']: ', data);
    this.sock.emit(type, data);
  }
  else {
    debug('Socket not connected, cannot send message');
    this.emit('error', new Error('Socket not connected'));
  }
};

YodlrClient.prototype._setupAudioClient = function _setupAudioClient(options) {
  var spk = this;

  var opts = {
    host: spk._audioUrl,
    env: spk._config.env
  };

  opts.name = options.name;
  opts.wsUrlBinary = options.wsUrlBinary;
  opts.accountId = options.accountId;
  opts.roomId = options.roomId;
  opts.participantId = options.participantId;
  opts.httpUrl = spk._config.httpUrl;
  opts.mic = spk._selectedMic;

  if (spk.audio && spk.audio.client) {
    spk.audio.client.reconnect(opts);
  }
  else {
    spk.audio.client = new AudioClient(opts, function onAC(data, sampleRate) {
      spk.audio.data = data;
      spk.audio.sampleRate = sampleRate;

      spk.emit(MSG.mediaAllowed, 'started');
      spk.audio.client.on(MSG.mediaAllowed, function onMediaAllowed(isAllowed) {
        spk.emit(MSG.mediaAllowed, isAllowed);
      });
    });

    spk.audio.client.on('audioData', function audioDataEvt(event) {
      spk.audio.data = event.data;
      spk.audio.sampleRate = event.sampleRate;
      spk._send(MSG.audioSetup, {
        port: spk.audio.data.port,
        sample_rate: spk.audio.sampleRate //jscs:disable
      });
    });

    spk.audio.client.on(MSG.userTalking, function onUserTalking(data) {
      // temporary fix
      this.rooms[spk.joinedRoom].setThisUserTalking(data);
    }.bind(spk));

    spk.audio.client.on(MSG.disconnected, function onDisconnected() {
      debug('audio client disconnected');
      spk._disconnected = true;
      spk.emit(MSG.disconnected);
      if (spk.audio && spk.audio.client) {
        spk.audio.client.setMicEnable(false);
        spk.audio.client.disconnect();
      }
      spk.disconnect();
      // No longer try to automatically reconnect
      // spk.sock.socket.reconnect();
      // spk.connect();
    });
  }
};

YodlrClient.prototype._setMicrophoneEnabled =
    function _setMicrophoneEnabled(data) {
  this.rooms[data.room]._setMicrophoneEnabled(data);
  if (this.audio && this.audio.client) {
    this.audio.client.setMicEnable(data.microphoneEnabled);
  }
};

YodlrClient.prototype._setSpeakerEnabled = function _setSpeakerEnabled(data) {
  this.rooms[data.room]._setSpeakerEnabled(data);
};

YodlrClient.prototype._setLockEnabled = function _setLockEnabled(data) {
  this.rooms[data.room]._setLockEnabled(data);
};

YodlrClient.prototype._userChanged = function _userChanged(data) {
  this.rooms[data.room]._userChanged(data);
};

YodlrClient.prototype._userJoined = function _userJoined(data) {
  this.rooms[data.room]._userJoined(data);
};

YodlrClient.prototype._userLeft = function _userLeft(data) {
  this.rooms[data.room]._userLeft(data);
};

YodlrClient.prototype._thisUserChanged = function _thisUserChanged(data) {
  this.user = data.user;
  if (this.audio && this.audio.client) {
    this.user.speakerVolume = this.audio.client.getVolume();
  }
  this.emit(MSG.thisUserChanged, this.user);
};

/**
 * Emitted when the browser meets requirements.
 *
 * @event YodlrClient#browserReqs
 */

/**
 * Emitted when connection is established to the server.
 *
 * @event YodlrClient#connected
 * @example
 * sClient.on('connected', function() {
 *  console.log('connection to the server established');
 * });
 */

 /**
 * Emitted when the connection is lost to the server.
 *
 * @event YodlrClient#disconnected
 * @example
 * sClient.on('disconnected', function() {
 *  console.log('disconnected from the server');
 * });
 */

/**
 * Emmited when this user cannot join room (make sure you provide a keycode if you are creating a room).
 *
 * @event YodlrClient#joinError
 * @type {object}
 * @property {object} room - Room object
 * @property {string} room.name - The room name
 * @property {string} room.error - The error message
 * @example
 * sClient.on('joinError', function(room) {
 *  console.log('Error joining the room', room);
 * });
 */

/**
 * Emitted when this user joins a room.
 *
 * @event YodlrClientRoom#joinedRoom
 * @type {object}
 * @property {object} room - Room object
 * @property {string} room.name - The room name
 * @property {boolean} room.lockEnabled - The room lock status
 * @example
 * sClient.on('joinedRoom', function(room) {
 *  console.log('Joined room: ', room);
 * });
 */

/**
 * Emitted when this user leaves a room.
 *
 * @event YodlrClientRoom#leftRoom
 * @type {object}
 * @property {object} room - Room object
 * @property {string} room.name - The room name
 * @example
 * sClient.on('leftRoom', function(room) {
 *  console.log('Left room: ', room);
 * });
 */

/**
 * Emitted when browser requests  event.
 *
 * @event YodlrClient#mediaAllowed
 * @type {object}
 * @property {string} data - The object
 * @property {string} data.allowed - The value of users access to microphone/speaker
 */

/**
 * Emitted when Yodlr library is ready.
 *
 * @event YodlrClient#ready
 * @example
 * sClient.on('ready', function() {
 *  console.log('Client initialization complete');
 * });
 */

/**
 * Emitted when chat message is received.
 *
 * @event YodlrClientRoom#receiveChatMessage
 * @type {object}
 * @property {object} data - The object
 * @property {string} data.user - The user name sending data
 * @property {string} data.room - The room name
 * @property {string} data.text - The chat message
 * @example
 * sClient.on('receiveChatMessage', function(data) {
 *  console.log('Chat message receieved: ', data);
 * });
 */

/**
 * Emitted when microphone state has changed.
 *
 * @event YodlrClientRoom#setMicrophoneEnabled
 * @type {object}
 * @property {object} data - The object
 * @property {boolean} data.microphoneEnabled - Microphone enabled/disabled
 * @property {string} data.room - The room name
 * @example
 * sClient.on('setMicrophoneEnabled', function(data) {
 *  console.log('Microphone enabled: ', data);
 * });
 */

/**
 * Emitted when speaker state has changed.
 *
 * @event YodlrClientRoom#setSpeakerEnabled
 * @type {object}
 * @property {object} data - The object
 * @property {boolean} data.speakerEnabled - Speaker enabled/disabled
 * @property {string} data.room - The room name
 * @example
 * sClient.on('setSpeakerEnabled', function(data) {
 *  console.log('Speaker enabled: ', data);
 * });
 */

 /**
  * Emitted when speaker volume has changed.
  *
  * @event YodlrClientRoom#setSpeakerVolume
  * @type {object}
  * @property {object} data - The object
  * @property {number} data.speakerVolume - Speaker enabled/disabled
  * @property {string} data.room - The room name
  * @example
  * sClient.on('setSpeakerVolume', function(data) {
  *  console.log('Speaker volume: ', data);
  * });
  */

/**
 * Emitted when room has been locked/unlocked.
 *
 * @event YodlrClientRoom#setLockedEnabled
 * @type {object}
 * @property {object} data - The object
 * @property {boolean} data.lockEnabled - Lock enabled/disabled
 * @property {string} data.room - The room name
 * @example
 * sClient.on('setLockedEnabled', function(data) {
 *  console.log('Room locked: ', data);
 * });
 */

/**
 * Emitted when an error has occured.
 *
 * @event YodlrClient#yodlrError
 * @type {object}
 * @property {object} err - The object
 * @property {string} err.message - The error message
 * @example
 * sClient.on('yodlrError', function(err) {
 *  console.log('Error: ', err);
 * });
 */

/**
 * Emitted when this user changes name.
 *
 * @event YodlrClient#thisUserChanged
 * @type {object}
 * @property {object} thisUser - User object
 * @property {string} thisUser.id - The user ID
 * @property {string} thisUser.name - The user name
 * @property {object} thisUser.rooms - Rooms the user is in
 * @example
 * sClient.on('thisUserChanged', function(thisUser) {
 *  console.log('My user has changed: ', thisUser);
 * });
 */

/**
 * Emitted when a user changes name.
 *
 * @event YodlrClientRoom#userChanged
 * @type {object}
 * @property {object} user - User object
 * @property {string} user.room - The room name
 * @property {object} user.user - The name of user changing
 * @example
 * sClient.on('userChanged', function(user) {
 *  console.log('Another user has changed: ', user);
 * });
 */

/**
 * Emitted when a user joins a room.
 *
 * @event YodlrClientRoom#userJoined
 * @type {object}
 * @property {object} user - User object
 * @property {string} user.room - The room name
 * @property {object} user.user - The name of user joining
 * @example
 * sClient.on('userJoined', function(user) {
 *  console.log('Another user has joined the room: ', user);
 * });
 */

/**
 * Emitted when a user leaves a room
 *
 * @event YodlrClientRoom#userLeft
 * @type {object}
 * @property {object} user - User object
 * @property {string} user.room - The room name
 * @property {object} user.user - The name of user leaving
 * @example
 * sClient.on('userLeft', function(user) {
 *  console.log('Another user has left the room: ', user);
 * });
 */

/**
 * Emitted when a browser is not supported
 *
 * @event YodlrClientRoom#unsupportedBrowser
 * @type {object}
 * @property {array} supportedBrowsers - Supported browsers array ('mobile' if on mobile device)
 * @example
 * sClient.on('unsupportedBrowser', function(supportedBrowsers) {
 *  console.log('This browser is not supported, please use one of the following: ', supportedBrowsers);
 * });
 */

YodlrClient.prototype._setupEventHandlers = function _setupEventHandlers() {
  this.sock.on(MSG.error, this._errorHandler.bind(this));
  this.sock.on(MSG.joinError, this._joinErrorHandler.bind(this));
  this.sock.on(MSG.kill, this._kill.bind(this));
  this.sock.on(MSG.ping, this._ping.bind(this));
  this.sock.on(MSG.pong, this._pong.bind(this));

  this.sock.on(MSG.joinedRoom, this._joinedRoom.bind(this));
  this.sock.on(MSG.leftRoom, this._leftRoom.bind(this));
  this.sock.on(MSG.receiveChatMessage, this._receiveChatMessage.bind(this));
  this.sock.on(MSG.receiveFileMessage, this._receiveFileMessage.bind(this));
  this.sock.on(MSG.receiveMessage, this._receiveMessage.bind(this));
  this.sock.on(MSG.setMicrophoneEnabled, this._setMicrophoneEnabled.bind(this));
  this.sock.on(MSG.setSpeakerEnabled, this._setSpeakerEnabled.bind(this));
  this.sock.on(MSG.setLockEnabled, this._setLockEnabled.bind(this));
  this.sock.on(MSG.thisUserChanged, this._thisUserChanged.bind(this));
  this.sock.on(MSG.userChanged, this._userChanged.bind(this));
  this.sock.on(MSG.userJoined, this._userJoined.bind(this));
  this.sock.on(MSG.userLeft, this._userLeft.bind(this));

  this._pingInterval = setInterval(this._sendPing.bind(this), 1000);
};

YodlrClient.prototype.debug = require('debug');
