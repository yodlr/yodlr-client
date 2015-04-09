var MSG = {
  fileUploadRequest: 'fileUploadRequest',     // {roomName, file, requestId, userId}
  fileUploadRequested: 'fileUploadRequested', // {requestId, fileId}
  fileUpload: 'fileUpload',                   // {fileId, requestID}
  fileUploaded: 'fileUploaded',               // {fileUrl, fileSize, fileName, fileId}
  connected: 'connected',                     // URL
  error: 'CaptainCabinetError'                // error
};

module.exports = MSG;
