var MSG = require('./api/socketio.js');

var YodlrMetric = module.exports = function YodlrMetric(socket) {
  this._socket = socket;
};

YodlrMetric.prototype.count = function count(metric, value) {
  this._socket.emit(MSG.metric, {
    type: 'count',
    key: metric,
    value: value
  });
};

YodlrMetric.prototype.timing = function timing(metric, value) {
  this._socket.emit(MSG.metric, {
    type: 'timing',
    key: metric,
    value: value
  });
};

YodlrMetric.prototype.gauge = function count(metric, value) {
  this._socket.emit(MSG.metric, {
    type: 'gauge',
    key: metric,
    value: value
  });
};
