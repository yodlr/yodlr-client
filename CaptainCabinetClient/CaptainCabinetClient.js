var MSG = require('../api/CaptainCabinetClient.js');
var io = require('socket.io-client');
var upload = require('socket.io-stream');
var events2 = require('eventemitter2');
var util = require('util');
var uuid = function uuid() {
  // taken from: https://gist.github.com/1308368
  return (function generate(a, b) {
  /*eslint-disable */
  // jscs:disable
    for(b=a=''; a++ < 36; b += a * 51 & 52 ? (a ^ 15 ? 8 ^ Math.random() *
  (a ^ 20 ? 16 : 4) : 4).toString(16) : '-') {}return b;})();
  // jscs:enable
  /*eslint-enable */
};

var fs = require('fs');
var path = require('path');
var debug = require('debug')('captaincabinetclient');

var tmpFiles = {};

/**
 * Initializes a CaptainCabinetClient object
 * @constructor
 * @param {object} [options] Options for CaptainCabinetClient
 * @param {string} [options.baseUrl] - URL the client should connect to
 * @param {string} [options.port] - port of the URL the client should connect to
 * @param {boolean} [options.debug] - Debug mode (true for on)
 * @returns {CaptainCabinetClient}
 * @example
 * var CaptainCabinetClient = require('CaptainCabinetClient');
 * var CCClient = new CaptainCabinetClient({baseUrl: 'http://localhost', port:8000, debug:true});
 */

var CaptainCabinetClient = module.exports = function constructor(options) {
  events2.EventEmitter2.call(this);
  debug('Instantiating client');
  if(!options) {
    throw new Error('Cannot create CaptainCabinetClient. No options provided');
  }
  if(!options.baseUrl) {
    throw new Error('Cannot create CaptainCabinetClient. No URL provided');
  }
  if(!options.port) {
    throw new Error('Cannot create CaptainCabinetClient. No port provided');
  }

  var CCC = this;

  CCC.server = options.baseUrl + ':' + options.port;
  debug('Connecting to ' + CCC.server);
  CCC.socket = io.connect(CCC.server, {
    'force new connection': true,
    transports: ['websocket']
  });

  CCC.socket.on('connect', function onConnected() {
    CCC._debug('CaptainCabinetClient connected to ' + CCC.server);
    CCC.emit(MSG.connected, CCC.server);
  });

  CCC.socket.on('error', function onError(err) {
    CCC._debug('Error', err);
    CCC.emit(MSG.error, err);
  });

  CCC.socket.on(MSG.fileUploadRequested,
    function onFileUploadRequested(data) {
    CCC._FileUploadRequested(data);
  });

  CCC.socket.on(MSG.fileUploaded, function onFileUploaded(data) {
    CCC._FileUploaded(data);
  });

  CCC.on(MSG.fileUploadRequest, function onFileUploadRequest(data) {
    CCC.FileUploadRequest(data.roomName, data.file, data.userId);
  });

  CCC.debug = options.debug || false;

};
util.inherits(CaptainCabinetClient, events2.EventEmitter2);

CaptainCabinetClient.prototype._debug = function _debug(str) {
  debug(str);
};

/**
 * Initial file upload request
 * @method
 * @param roomName - room to upload to
 * @param file - either a path to a local file or an HTML5 file object
 * @param userId - ID of user uploading
 * @emits CaptainCabinetClient#FileUploadRequest
 * @example
 * CCClient.FileUploadRequest('testroom', 'test.txt', 'admin1');
 */

CaptainCabinetClient.prototype.FileUploadRequest =
    function FileUploadRequest(roomName, file, userId) {
  var fileName;
  if (file.name) {
    fileName = file.name;
  } else {
    fileName = path.basename(file);
  }

  //perform sanitizations
  //fileName = fileName.replace(/\s/g, '_');
  fileName = fileName.replace(/\//g, ':');

  var requestId = uuid();
  tmpFiles[requestId] = {'fileName': fileName,
  'requestId': requestId, 'file': file};

  this.socket.emit(MSG.fileUploadRequest, {'roomName': roomName,
    'fileName': fileName, 'requestId': requestId, 'userId': userId});
};

/**
 * File request acknowledged
 * @method
 * @param [data] - data array from received message
 * @param [data.error] - error (if any) encountered by server
 * @param [data.requestId] - client generated request ID
 * @param [data.fileId] - server generated file ID
 * @emits CaptainCabinetClient#error
 * @emits CaptainCabinetClient#fileUploadRequested
 */

CaptainCabinetClient.prototype._FileUploadRequested =
    function _FileUploadRequested(data) {
  this._debug('CaptainCabinetClient received ' +
    MSG.fileUploadRequested + ': ' + JSON.stringify(data));

  if(data.error) {
    this.emit(MSG.error, new Error(data));
    return;
  }

  if(!tmpFiles[data.requestId]) {
    this.emit(MSG.error,
      new Error('Could not locate request: ' + data.requestId));
    return;
  }
  else {
    tmpFiles[data.requestId].fileId = data.fileId;
  }

  this.emit(MSG.fileUploadRequested, {'fileId': data.fileId,
    'requestId': data.requestId});

  this._FileUpload(data.requestId, data.fileId);
};

/**
 * Being file upload process
 * @method
 * @param requestId - client generated request Id
 * @param fileId - server generated file Id
 * @emits CaptainCabinetClient#fileUpload
 * @example
 * CCClient.on('fileUploadRequested', function(data) {
      CCClient.FileUpload(data['requestId'], data['fileId']);
   });
 */

CaptainCabinetClient.prototype._FileUpload =
    function _FileUpload(requestId, fileId) {
  this.emit(MSG.fileUpload, {'requestId': requestId,
    'fileId': fileId });

  if(!tmpFiles[requestId] ||
    !tmpFiles[requestId].fileId ||
    tmpFiles[requestId].fileId !== fileId) {
    this.emit(MSG.error,
      new Error('Invalid request or file ID.  requestId: ' +
        requestId + 'fileId: ' + fileId));
    return;
  }

  var stream = upload.createStream();

  upload(this.socket).emit(MSG.fileUpload, stream,
    {'fileId': fileId, 'requestId': requestId});

  if (typeof window === 'undefined') {
    fs.createReadStream(tmpFiles[requestId].file).pipe(stream);
  } else {
    upload.createBlobReadStream(tmpFiles[requestId].file).pipe(stream);
  }
};

/**
 * File upload completed
 * @method
 * @param [data] - data array from received message
 * @param [data.error] - error (if any) encountered by server
 * @param [data.fileUrl] - destination URL of uploaded file
 * @param [data.fileSize] - size in bytes of uploaded file
 * @param [data.fileName] - name of uploaded file
 * @param [data.fileId] - server generated ID of uploaded file
 * @emits CaptainCabinetClient#error
 * @emits CaptainCabinetClient#fileUploadRequesteded
 */

CaptainCabinetClient.prototype._FileUploaded =
    function _FileUploaded(data) {
  this._debug('CaptainCabinetClient received ' + MSG.fileUploaded +
    ': ' + JSON.stringify(data));

  if(data.error) {
    this.emit(MSG.error, new Error('FileUpload failed:' + data));
    delete tmpFiles[data.requestId];
    return;
  }

  this.emit(MSG.fileUploaded, {'fileUrl': data.fileUrl,
    'fileSize': data.fileSize, 'fileName': data.fileName,
    'fileId': data.fileId});

  this._debug('CaptainCabinetClient upload sequence complete ',
    JSON.stringify(data));

  delete tmpFiles[data.requestId];
};
