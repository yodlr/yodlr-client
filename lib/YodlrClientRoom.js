var events2 = require('eventemitter2');
var util = require('util');
var MSG = require('./api');
var CC = require('captaincabinet-client');
var d = require('debug');

/**
 * Initializes a YodlrClientRoom object
 * @constructor
 * @param {object} options Options for YodlrClient
 * @param options.name The name of the YodlrClientRoom
 * @param options.config The YodlrClient config object
 * @param options.audio The YodlrClient audio object
 * @param options.socket The YodlrClient websocket
 * @throws When incorrect options are passed
 * @returns {YodlrClientRoom}
 * @example
 * var sClient = new Yodlr();
 * var sRoom;
 * sClient.on('ready', function() {
 *  sRoom = sClient.joinRoom({room: 'example', keycode: 'myKeycode'});
 * });
 */

var YodlrClientRoom = module.exports = function YodlrClientRoom(options) {
  events2.EventEmitter2.call(this);

  var sRoom = this;
  if (!options.socket || !options.name || !options.audio || !options.config) {
    throw new Error('Cannot create room. Incorrect options params.');
  }
  options.name = options.name.toLowerCase();
  sRoom.debug = d('yodlr:room:' + options.name);
  sRoom.config = options.config;
  sRoom.audio = options.audio;
  sRoom.sock = options.socket;
  sRoom.lockEnabled = false;
  sRoom.name = options.name;
  sRoom.users = {};
  sRoom.files = [];

  sRoom.captaincabinetClient = new CC({
    baseUrl: sRoom.config.ccUrl,
    port: sRoom.config.ccPort,
    debug: true
  });

  sRoom.captaincabinetClient.on('error', function ccOnError(err) {
    sRoom.debug('CaptainCabinet Error', err);
    sRoom.emit(MSG.error, err);
  });

  sRoom.captaincabinetClient.on('ccError', function ccOnError(err) {
    sRoom.debug('CaptainCabinet Error', err);
    sRoom.emit(MSG.error, err);
  });

  sRoom.captaincabinetClient.on('connected', function ccOnConnected() {
    sRoom.debug('CaptainCabinet connected to server', sRoom.config.ccUrl
      + ':' + sRoom.config.ccPort);
  });

  sRoom.captaincabinetClient.on('fileUploadRequested',
      function onFileUploadRequested(data) {
    sRoom.debug('File upload requested',
      'fileId:', data.fileId, 'requestId', data.requestId);
  });

  sRoom.captaincabinetClient.on('fileUploaded', function onFileUploaded(data) {
    sRoom.debug('File uploaded',
      'fileName', data.fileName,
      'fileId:', data.fileId, 'size:', data.fileSize);
    // FIXME: Upload eventlistener hack (2/2) :-/ RHK
    sRoom.sock.emit(MSG.sendFileMessage, {
      user: sRoom.user,
      room: sRoom.name,
      data: data
    });
  });
};
util.inherits(YodlrClientRoom, events2.EventEmitter2);

/**
 * Gets a list of users in the room
 * @method
 * @returns {object} users
 * @example
 * var users = sRoom.getUsers();
 */

YodlrClientRoom.prototype.getUsers = function getUsers() {
  return this.users;
};

/**
 * Sends chat text
 * @method
 * @param {string} user The name of the sender
 * @param {string} text The message to be sent
 * @example
 * sRoom.sendChatMessage('user: myUserName', text: 'hello, world!');
 */

YodlrClientRoom.prototype.sendChatMessage =
    function sendChatMessage(user, text) {
  this.debug('Sending chatMessage', 'Text:', text);
  this.sock.emit(MSG.sendChatMessage, {
    user: user,
    room: this.name,
    text: text
  });
};

/**
 * Sends file
 * @method
 * @param {string} user The name of the sender
 * @param {string} file The file to be sent
 * @example
 * sRoom.sendChatMessage('user: myUserName', file: '/myFileName.txt');
 */

YodlrClientRoom.prototype.sendFileMessage =
    function sendFileMessage(user, file) {
  var room = this;
  room.debug('Uploading file ', file.name);
  room.captaincabinetClient.FileUploadRequest(room.roomId, file, user);
  // FIXME: Upload eventlistener hack (1/2) :-/ RHK
  room.user = user;
};

/**
 * Enables or disables room password lock
 * @method
 * @param {boolean} lockEnabled Lock/Unlock room
 * @param {string} password The password to lock the room
 * @emits YodlrClientRoom#setLockEnabled
 * @example
 * sRoom.setLockEnable(true, 'superSecretPassword');
 */

YodlrClientRoom.prototype.setLockEnable =
    function setLockEnable(lockEnabled, password) {
  this.debug('Setting room lock to ' + lockEnabled);
  this._send(MSG.setLockEnable, {
    lockEnabled: lockEnabled,
    password: password,
    roomName: this.name
  });
};

/**
 * Enables or disables microphone audio
 * @method
 * @param {boolean} microphoneEnabled
 * @emits YodlrClientRoom#setMicrophoneEnabled
 * @example
 * sRoom.setMicrophoneEnable(true);
 */

YodlrClientRoom.prototype.setMicrophoneEnable =
    function setMicrophoneEnable(microphoneEnabled) {
  this._send(MSG.setMicrophoneEnable, {
    microphoneEnabled: microphoneEnabled,
    roomName: this.name
  });
};

/**
 * Enables or disables speaker audio
 * @method
 * @param {boolean} speakerEnabled
 * @emits YodlrClientRoom#setSpeakerEnabled
 * @example
 * sRoom.setSpeakerEnable(true);
 */

YodlrClientRoom.prototype.setSpeakerEnable =
    function setSpeakerEnable(speakerEnabled) {
  this._send(MSG.setSpeakerEnable, {
    speakerEnabled: speakerEnabled,
    roomName: this.name
  });
};

/**
 * Sets the speaker volume to the specified value. 0 is 'off', 2.0 is the default.
 * @method
 * @param {number} speakerVolume
 * @emits YodlrClientRoom#setSpeakerVolume
 * @example
 * sRoom.setSpeakerVolume(3.0);
 */

YodlrClientRoom.prototype.setSpeakerVolume =
    function setSpeakerVolume(speakerVolume) {
  var room = this;
  var ret = this.audio.client.setVolume(speakerVolume);
  process.nextTick(function onNextTick() {
    room.emit(MSG.setSpeakerVolume, {speakerVolume: ret, room: room.name});
  });
};

/**
 * Gets the current speaker volume.
 * @method
 * @returns {number} speakerVolume
 * @example
 * sRoom.setSpeakerVolume(3.0);
 */

YodlrClientRoom.prototype.getSpeakerVolume = function getSpeakerVolume() {
  return this.audio.client.getVolume();
};

/**
 * Sends user talking status
 * @method
 * @param {boolean} userTalking
 * @emits YodlrClientRoom#thisUserChanged
 * @example
 * sRoom.setUserTalking(true);
 */

YodlrClientRoom.prototype.setThisUserTalking =
    function setThisUserTalking(userTalking) {
  this._send(MSG.setThisUserTalking, {
    userTalking: userTalking,
    roomName: this.name
  });
};

/**
 * Send presentation start command
 * @method
 * @param {string} fileId
 * @param {number} pageNumber
 * @emits YodlrClientRoom#startPresentation
 * @example
 * sRoom.startPresentation('1234567', 1);
 */

YodlrClientRoom.prototype.startPresentation =
    function startPresentation(fileId, pageNumber) {
  this._send(MSG.startPresentation, {
    fileId: fileId,
    pageNumber: pageNumber,
    roomName: this.name
  });
};

/**
 * Send presentation stop command
 * @method
 * @emits YodlrClientRoom#stopPresentation
 * @example
 * sRoom.stopPresentation();
 */

YodlrClientRoom.prototype.stopPresentation =
    function stopPresentation() {
  this._send(MSG.stopPresentation, {
    roomName: this.name
  });
};

/**
 * Send presentation set page command
 * @method
 * @param {number} pageNumber
 * @emits YodlrClientRoom#setPresentationPage
 * @example
 * sRoom.setPresentationPage(6);
 */

YodlrClientRoom.prototype.setPresentationPage =
    function setPresentationPage(pageNumber) {
  this._send(MSG.setPresentationPage, {
    pageNumber: pageNumber,
    roomName: this.name
  });
};


/**
 * Sends user presentation viewing status
 * @method
 * @param {boolean} viewingPresentation
 * @emits YodlrClientRoom#thisUserChanged
 * @example
 * sRoom.setUserViewingPresentation(true);
 */

YodlrClientRoom.prototype.setUserViewPresentation =
    function setUserViewPresentation(viewingPresentation) {
  this._send(MSG.setUserViewPresentation, {
    viewingPresentation: viewingPresentation,
    roomName: this.name
  });
};

/**
 * Sends user hand raised status
 * @method
 * @param {boolean} handRaised
 * @emits YodlrClientRoom#thisUserChanged
 * @example
 * sRoom.setUserHandRaised(true);
 */

YodlrClientRoom.prototype.setUserHandRaise =
    function setUserHandRaise(handRaised) {
  this._send(MSG.setUserHandRaise, {
    handRaised: handRaised,
    roomName: this.name
  });
};

/**
 * Starts recording
 * @method
 * @example
 * sRoom.startRecording();
 */

YodlrClientRoom.prototype.startRecording = function startRecording() {
  this._send(MSG.startRecording, {
    roomName: this.name
  });
};

/**
 * Stops recording
 * @method
 * @example
 * sRoom.stopRecording();
 */

YodlrClientRoom.prototype.stopRecording = function stopRecording() {
  this._send(MSG.stopRecording, {
    roomName: this.name
  });
};


YodlrClientRoom.prototype._isMine = function _isMine(data) {
  if (data.room === this.name) {
    return true;
  }
  else {
    return false;
  }
};

/*
 * @emits joinedRoom
 */

YodlrClientRoom.prototype._joinedRoom = function _joinedRoom(data) {
  if (!this._isMine(data)) {
    return;
  }
  this.debug('Successfully joined room',
    'participantId:', data.participantId,
    'roomId:', data.roomId,
    'accountId:', data.accountId);
  this.lockEnabled = data.lockEnabled;
  this.presentationActive = data.presentationActive;
  this.presentationFile = data.presentationFile;
  this.presentationPage = data.presentationPage;
  this.roomId = data.roomId;
  this.roomType = data.roomType;
  this.capabilities = data.capabilities;
  this.emit(MSG.joinedRoom, data);
};

/*
 * @emits leftRoom
 */

YodlrClientRoom.prototype._leftRoom = function _leftRoom(data) {
  if (!this._isMine(data)) {
    return;
  }
  this.debug('User has left the room', data);
  delete this.sock;
  this.emit(MSG.leftRoom, data.room);
};

/*
 * @emits receiveChatMessage
 */

YodlrClientRoom.prototype._receiveChatMessage =
    function _receiveChatMessage(data) {
  this.debug('Received chat message from ' + data.user,
    'Text:', data.text);
  this.emit(MSG.receiveChatMessage, data);
};

/*
 * @emits receiveFileMessage
 */

YodlrClientRoom.prototype._receiveFileMessage =
    function _receiveFileMessage(data) {
  this.debug('Received file message',
    'fileName:', data.data.fileName,
    'fileId:', data.data.fileId,
    'fileSize:', data.data.fileSize);
  this.emit(MSG.receiveFileMessage, data);
};

/*
 * @emits receiveMessage
 */

YodlrClientRoom.prototype._receiveMessage =
    function _receiveMessage(data) {
  this.debug('Received message from ' + data.sender.name,
    data);
  this.emit(MSG.receiveMessage, data);
};

YodlrClientRoom.prototype._send = function _send(type, data) {
  if (this.sock && typeof this.sock.emit === 'function') {
    // TODO: improve this to make sure we're connected?
    this.debug('Sending ' + type + ' message', data);
    this.sock.emit(type, data);
  }
  else {
    this.emit('error', new Error('Socket not connected'));
  }
};

/*
 * @emits setMicrophoneEnabled
 */

YodlrClientRoom.prototype._setMicrophoneEnabled =
    function _setMicrophoneEnabled(data) {
  if (!this._isMine(data)) {
    return;
  }
  if (this.audio && this.audio.client) {
    this.audio.client.setMicEnable(data.microphoneEnabled);
  }
  this.emit(MSG.setMicrophoneEnabled, {
    microphoneEnabled: data.microphoneEnabled,
    roomName: data.roomName
  });
};

/*
 * @emits setSpeakerEnabled
 */

YodlrClientRoom.prototype._setSpeakerEnabled =
    function _setSpeakerEnabled(data) {
  if (!this._isMine(data)) {
    return;
  }
  this.emit(MSG.setSpeakerEnabled, {
    speakerEnabled: data.speakerEnabled,
    roomName: data.roomName
  });
};

/*
 * @emits setLockEnabled
 */

YodlrClientRoom.prototype._setLockEnabled = function _setLockEnabled(data) {
  if (!this._isMine(data)) {
    return;
  }
  this.lockEnabled = data.lockEnabled;
  this.debug('LockEnabled set to ' + data.lockEnabled);
  this.emit(MSG.setLockEnabled, {
    setLockEnabled: data.lockEnabled,
    roomName: data.room
  });
};

/*
 * @emits userChanged
 */

YodlrClientRoom.prototype._userChanged = function _userChanged(data) {
  if (!this._isMine(data)) {
    return;
  }
  else {
    this.debug('User ' + data.user.name + ' (' + data.user.id + ') changed',
      'userTalking:', data.user.userTalking,
      'speakerEnabled:', data.user.speakerEnabled,
      'micEnabled:', data.user.microphoneEnabled);
    if (typeof data.user.userTalking === 'string') {
      data.user.userTalking = (data.user.userTalking === 'true');
    }
    this.users[data.user.id] = data.user;
    this.emit(MSG.userChanged, data.user);
  }
};

/*
 * @emits userJoined
 */

YodlrClientRoom.prototype._userJoined = function _userJoined(data) {
  if (!this._isMine(data)) {
    return;
  }
  else {
    this.debug('User joined the room',
      'name:', data.user.name,
      'id:', data.user.id);
    if (typeof data.user.userTalking === 'string') {
      data.user.userTalking = (data.user.userTalking === 'true');
    }
    this.users[data.user.id] = data.user;
    this.emit(MSG.userJoined, data.user);
  }
};

/*
 * @emits userLeft
 */

YodlrClientRoom.prototype._userLeft = function _userLeft(data) {
  if (!this._isMine(data)) {
    return;
  }
  else {
    this.debug('User left the room',
      'name:', data.user.name,
      'id:', data.user.id);
    delete this.users[data.user.id];
    this.emit(MSG.userLeft, data.user);
  }
};
