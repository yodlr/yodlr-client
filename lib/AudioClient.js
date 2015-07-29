var events2 = require('eventemitter2');
var util = require('util');
var MSG = require('./api');
var webrtcSupport = require('webrtcsupport');
var getUserMedia = require('getusermedia');
var hark = require('hark');
var AudioRouterClient = require('audiorouter-client');
var audioContext;
if (webrtcSupport.AudioContext) {
  audioContext = new webrtcSupport.AudioContext();
}
var debug = require('debug')('yodlr:audioclient');
var dBuf = require('debug')('yodlr:audioclient:buffermgmt');

var SAMPLE_RATE;
var NET_SAMPLE_RATE;

var FRAME_SIZE = 512;

var zerobuf = [];

var ALWAYS_SEND = false;

var AudioClient = module.exports = function AudioClient(opts, callback) {
  events2.EventEmitter2.call(this);
  SAMPLE_RATE = audioContext.sampleRate;
  NET_SAMPLE_RATE = SAMPLE_RATE;
  NET_SAMPLE_RATE = NET_SAMPLE_RATE/2;
  var ac = this;
  var host = opts.host;
  var env = opts.env;
  ac._mic = opts.mic || '';
  var ws_host = "wss://";
  if (env === 'DEVELOPMENT') {
    ws_host = "ws://";
  }
  ac.ws_host = ws_host + host+'/';

  ac.connected = false;
  ac.started = false;
  ac.playing = false;
  ac.rxBuffer = [];
  ac.ptt = true;
  ac.callback = callback;
  ac.audioRouteSet = false;
  ac.send_audio = 1;
  ac.talking = false;

  // Buffer management data
  ac.MANAGE_BUFFER = true;
  ac.HOLD_OFF_MS = 30;
  ac.MAX_BUF_SIZE = Math.floor(200 * SAMPLE_RATE / 1000);
  ac.MID_POINT = Math.floor(ac.HOLD_OFF_MS * SAMPLE_RATE / 1000);
  ac.MATCH_WIN_SIZE = 8; // size of match window in samples
  ac.SEARCH_WIN_SIZE = Math.floor(8 * SAMPLE_RATE / 1000); // 8ms audio in samples

  ac.SAMP_ERR = ac.MID_POINT / 2; // half the midpoint
  ac.bufStats = {
    added: 0,
    removed: 0,
    successes: 0,
    attempts: 0,
    successRate: 0,
    attemptRemove: 0,
    attemptAdd: 0
  };

  ac.protocol = getParameterByName('protocol') ? getParameterByName('protocol') : 'peer';
  ac.protocolUdp = Boolean(getParameterByName('udp') ? getParameterByName('udp') : true);

  if (ac.protocol !== 'peer') {
    setInterval(function() {
      dBuf('Stats', 'attempts:', ac.bufStats.attempts, 'attemptRemove', ac.bufStats.attemptRemove,
            'attemptAdd', ac.bufStats.attemptAdd);
      dBuf('Stats', 'successes:', ac.bufStats.successes, 'successRate', ac.bufStats.successRate);
      dBuf('Stats', 'samples added:',ac.bufStats.added,'samples removed',ac.bufStats.removed);
      dBuf('Stats', 'rxBuffer length:', ac.rxBuffer.length,
            'Buffer mid-point', ac.MID_POINT,
            'Max buffer size', ac.MAX_BUF_SIZE);
    }, 10000);
  }

  ac._setupAudioRouterClient(opts);
};
util.inherits(AudioClient, events2.EventEmitter2);

function getParameterByName(name) {
  var match = RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
  return match && decodeURIComponent(match[1].replace(/\+/g, ' '));
};

AudioClient.prototype._setupAudioRouterClient = function _setupAudioRouterClient(opts) {
  var ac = this;

  if(opts.wsUrlBinary === 'wss://audio.dev-getyodlr.com') {
    opts.wsUrlBinary = opts.wsUrlBinary+':1443';
  }

  var arcOpts = {
    wsUrlBinary: opts.wsUrlBinary,
    account: opts.accountId,
    room: opts.roomId,
    participant: opts.participantId,
    rate: NET_SAMPLE_RATE,
    protocol: ac.protocol,
    udp: ac.protocolUdp
  };

  // reconnecting
  if(ac.arc) {
    ac.arc.close();
    delete ac.arc;
  }
  debug('Creating AudioRouterClient',
    'url', arcOpts.wsUrlBinary,
    'participantId:', arcOpts.participant,
    'roomId:', arcOpts.room,
    'accountId:', arcOpts.account);
  ac.arc = new AudioRouterClient(arcOpts);

  ac.arc.on(MSG.connected, function() {
    debug('AudioRouterClient connected');
    ac.connected = true;
    ac.start();
  });

  ac.arc.on(MSG.audioMessage, function(audio) {
    var fbuf = new Int16Array(audio);
    var upsampled = ac._upsample(fbuf);
    ac._manageRxBuffer(upsampled);
  });

  ac.arc.on(MSG.reconnectError, function() {
    debug('AudioRouterClient reconnect error');
    ac.emit(MSG.disconnected, MSG.reconnectError);
  });

  ac.arc.on(MSG.disconnected, function() {
    ac.emit(MSG.disconnected);
  });
};

AudioClient.prototype.start = function start() {
  var ac = this;
  if(ac.started) {
    return;
  }
  ac.started = true;
  debug('Requesting getUserMedia', 'sourceId: ', ac._mic);
  getUserMedia({
    audio: {
      optional: [
        {googEchoCancellation:true},
        {googAutoGainControl:true},
        {googNoiseSuppression:true},
        {googHighpassFilter:true},
        {googAudioMirroring:false},
        {googNoiseSuppression2:true},
        {googEchoCancellation2:true},
        {googAutoGainControl2:true},
        {googDucking:false},
        {sourceId: ac._mic}
      ]
    },
    video: false
  }, ac._onGetUserMedia.bind(ac));
};

AudioClient.prototype.changeMicrophone = function changeMicrophone(mic) {
  var ac = this;
  if (!ac.started) {
    return ac.emit(MSG.error, new Error('AudioClient not started, can\'t change microphone'));
  }
  ac._mic = mic;
  debug('Microphone changed, requesting getUserMedia', 'sourceId: ', ac._mic);
  getUserMedia({
    audio: {
      optional: [
        {googEchoCancellation:true},
        {googAutoGainControl:true},
        {googNoiseSuppression:true},
        {googHighpassFilter:true},
        {googAudioMirroring:false},
        {googNoiseSuppression2:true},
        {googEchoCancellation2:true},
        {googAutoGainControl2:true},
        {googDucking:false},
        {sourceId: ac._mic}
      ]
    },
    video: false
  }, ac._onGUMNewMic.bind(ac));
};

AudioClient.prototype._onGUMNewMic = function _onGUMNewMic(err, stream) {
  var ac = this;
  if (err) {
    return ac.emit(MSG.mediaAllowed, err);
  }
  ac._setupHark(stream);
  if (ac.protocol === 'peer') {
    ac.stream = stream;
    ac.arc.setStream(stream);
    debug('Set GUM Stream in ARC');
    return;
  }
  else {
    ac.audioInput.disconnect(0);
    ac.audioInput = audioContext.createMediaStreamSource(stream);
    ac.audioInput.connect(ac.filterNode);
  }
};

AudioClient.prototype._onGetUserMedia = function _onGetUserMedia(err, stream) {
  var ac = this;
  if (err) {
    debug('GetUserMedia error', err);
    return ac.emit(MSG.mediaAllowed, err);
  }

  debug('GetUserMedia successful, setting up WebAudio Components');
  ac.stream = stream;
  ac._setupHark(stream);

  // alerting the browser that audio worked
  ac.emit(MSG.mediaAllowed, 'allowed');

  if (ac.protocol === 'peer') {
    ac.arc.setStream(stream);
    debug('Set GUM Stream in ARC');
    return;
  }
  //Mixer to link mic audio and incoming audio from socket
  ac.fakeMerger = audioContext.createChannelMerger();

  // mic -> bandpass -> LP -> downsample -> WS

  // Microphone audio
  ac.audioInput = audioContext.createMediaStreamSource(stream);
  ac.filterNode = audioContext.createBiquadFilter();
  ac.filterNode.type = "bandpass";
  ac.filterNode.frequency.value = 775;
  ac.filterNode.Q.value = 0.28;

  // Run pre-downsample audio through lowpass filter
  ac.downLP = audioContext.createBiquadFilter();
  ac.downLP.frequency.value = 7000;
  ac.downLP.type = 'lowpass';

  // Node that sends audio over WS to server
  ac.txAudioNode = audioContext.createScriptProcessor(FRAME_SIZE,1,1);
  ac.txAudioNode.onaudioprocess = ac._txAudioNode.bind(ac);
  FRAME_SIZE = ac.txAudioNode.bufferSize;

  ac.audioInput.connect(ac.filterNode);
  ac.filterNode.connect(ac.downLP);
  ac.downLP.connect(ac.txAudioNode);
  ac.txAudioNode.connect(ac.fakeMerger); // fake thing?

  ac.fakeGain = audioContext.createGain();
  ac.fakeGain.gain.value = 0.0;
  ac.fakeGain.connect(audioContext.destination);
  ac.fakeMerger.connect(ac.fakeGain);

  // WS -> BufMgmt -> upsample -> LP -> Gain -> Speaker

  // Pull audio from WS buffer, manage buffer size, upsample
  ac.rxAudio = audioContext.createScriptProcessor(FRAME_SIZE,1,1);
  ac.rxAudio.onaudioprocess = ac._onRxAudio.bind(ac);

  ac.upLP = audioContext.createBiquadFilter();
  ac.upLP.frequency.value = 8000;
  ac.upLP.type = 'lowpass';

  ac.gainNode = audioContext.createGain();
  ac.gainNode.gain.value = 3.0;

  ac.rxAudio.connect(ac.upLP);
  ac.upLP.connect(ac.gainNode);
  ac.gainNode.connect(audioContext.destination);

  zerobuf = new Int16Array(FRAME_SIZE);

  debug("WebAudio setup complete",
    "Net sample rate:", NET_SAMPLE_RATE,
    "Frame Size:", FRAME_SIZE);
};

AudioClient.prototype.setVolume = function setVolume(vol) {
  var ac = this;
  if (!ac.gainNode) {
    return 0;
  }
  debug('Volume set to ' + vol);
  ac.gainNode.gain.value = vol;
  return vol;
};

AudioClient.prototype.getVolume = function getVolume() {
  var ac = this;
  if (!ac.gainNode) {
    return 0;
  }
  return ac.gainNode.gain.value;
};

AudioClient.prototype._upsample = function _upsample(audio) {
  var audioMsg = [];

  var i;
  for(i=0; i < audio.length; i++) {
    audioMsg.push(audio[i]);
  }

  var ac = this;
  var newAudio = [];
  var samples = audioMsg.length;

  var v0 = 0;
  if (ac.rxBuffer.length) {
    v0 = floatToPcm(ac.rxBuffer[ac.rxBuffer.length-1]); // get the last item in rxBuffer
  }
  for (i=0;i<samples;i++) {
    var v1 = audioMsg.shift();
    var interp = Math.floor((v0+v1)/2);
    newAudio.push(interp);
    newAudio.push(v1);
    v0 = v1;
  }
  return newAudio;
};

/*
*
*  WebAudio Processing Nodes
*
*/

AudioClient.prototype._txAudioNode = function _txAudioNode(event) {
  // TASKS:
  // * downsample
  // * convert to pcm
  // * send over websocket
  var ac = this;
  var incoming = event.inputBuffer.getChannelData(0);
  var samples = incoming.length;
  var pcmAudio;

  var i, pcm;
  // Downsample our audio
  pcmAudio = new Int16Array(samples/2);
  for (i = 0; i < samples; i+=2) {
    pcm = parseInt(incoming[i]*32767);
    pcm = Math.max(pcm, -32768);
    pcm = Math.min(pcm, 32767);
    pcmAudio[i/2] = pcm;
  }

  // if we're actually supposed to send the audio
  if (ac.connected && ac.ptt && (ALWAYS_SEND || ac.send_audio)) {
    ac.arc.sendAudio(pcmAudio);
  }
};

function floatToPcm(float) {
  var pcm = parseInt(float * 32767);
  pcm = Math.max(pcm, -32768);
  pcm = Math.min(pcm, 32767);
  return pcm;
}
function pcmToFloat(pcm) {
  var flt = parseFloat(pcm / 32768);
  flt = Math.max(flt, -1.0);
  flt = Math.min(flt, 1.0);
  return flt;
}

// RX Audio Pipeline
AudioClient.prototype._onRxAudio = function _onRxAudio(event) {
  var ac = this;
  var i;
  var rxBufLen = ac.rxBuffer.length;
  var playing = ac.playing;
  var flt, pcm;
  var speakerbuf = [];
  //Nothing in the buffer, or we have just started receiving and we want
  //to buffer up the audio before playing back
  if (rxBufLen === 0 || (!playing && rxBufLen < ac.MID_POINT)) {
    event.outputBuffer.getChannelData(0).set(zerobuf);
  }
  else if (rxBufLen > ac.MAX_BUF_SIZE) {
    debug('Buffersize got to large, flushing');
    ac.rxBuffer = [];
    event.outputBuffer.getChannelData(0).set(zerobuf);
  }
  else if (rxBufLen > FRAME_SIZE) {
    //We've got at least one full buffer, play it
    ac.playing = true;
    speakerbuf = ac.rxBuffer.splice(0, FRAME_SIZE);
    event.outputBuffer.getChannelData(0).set(speakerbuf);
    //We've got a partial buffer, so
    // play the remaining then stop, wait for full buffer
  } else {
    speakerbuf = ac.rxBuffer.slice(0, rxBufLen);
    //pad remaining buffer with silence
    var remainderLength = FRAME_SIZE - speakerbuf.length;
    for (i=0; i < remainderLength; i++) {
      speakerbuf.push(0.0);
    }
    event.outputBuffer.getChannelData(0).set(speakerbuf);
    ac.playing = false;
  }
};

AudioClient.prototype.reconnect = function reconnect(opts) {
  var ac = this;
  ac._setupAudioRouterClient(opts);
};

AudioClient.prototype.disconnect = function disconnect() {
  var ac = this;
  ac.audioRouteSet = false;
  ac.connected = false;
  debug('Disconnecting');
  ac.arc.close();
};

AudioClient.prototype.setMicEnable = function setMicEnable(value) {
  var ac = this;
  ac.ptt = value;
  debug('Setting micEnable to ' + value);
  if (ac.stream) {
    ac.stream.getAudioTracks()[0].enabled = value;
  }
  if (!value && ac.talking) { // mic being disabled, currently talking
    ac.talking = false;
    ac.emit(MSG.userTalking, ac.talking);
  }
};

AudioClient.prototype._setupHark = function _setupHark(stream) {
  var ac = this;
  var options = {
    threshold: -50,
    interval: 50
  };
  if (ac.hark) {
    ac.hark.stop();
    ac.hark.off('speaking');
    ac.hark.off('stopped_speaking');
    ac.hark = null;
  }
  ac.hark = hark(stream, options);

  ac.hark.on('speaking', function speaking() {
    ac.talking = true;
    if (ac.ptt) {
      ac.emit(MSG.userTalking, ac.talking);
    }
  });

  ac.hark.on('stopped_speaking', function stoppedSpeaking() {
    ac.talking = false;
    if (ac.ptt) {
      ac.emit(MSG.userTalking, ac.talking);
    }
  });
}

/******
 *
 * Buffer Management Code
 *
 *****/

AudioClient.prototype._manageRxBuffer = function _manageRxBuffer(input) {
  var ac = this;
  var rxAudio = input.slice();
  if (!ac.MANAGE_BUFFER) { // if not managing, just add it on
    for (var i = 0; i < rxAudio.length; i++) {
      rxAudio[i] = pcmToFloat(rxAudio[i]);
    }
    return ac.rxBuffer = ac.rxBuffer.concat(rxAudio);
  }
  var offset = ac._getOffset();
  var res = 0;
  if (offset > 0 && offset > ac.SAMP_ERR) {
    ac.bufStats.attemptOvers++;
    res = ac._add_remove_samples(rxAudio, false);
  }
  else if (offset < 0 && offset < -1*ac.SAMP_ERR) {
    ac.bufStats.attemptUnders++;
    res = ac._add_remove_samples(rxAudio, true);
  }
  for (var i = 0; i < rxAudio.length; i++) {
    rxAudio[i] = pcmToFloat(rxAudio[i]);
  }
  ac.rxBuffer = ac.rxBuffer.concat(rxAudio);
  return res;
};

AudioClient.prototype._add_remove_samples = function _add_remove_samples(rxAudio, do_add_samples) {
  var ac = this;
  var samples = rxAudio.length;
  var swin=[];
  var start = 0, end = 0, match_win = 0, incr = 0;
  var res = 0;

  var index = 0; // index of start of search window (rxAudio)

  if (samples < 64) {
    return 0;
  }

  if (samples > ac.SEARCH_WIN_SIZE) {
    index = samples - ac.SEARCH_WIN_SIZE;
    samples = ac.SEARCH_WIN_SIZE;
  }
  swin = rxAudio.slice(index, samples + index); // copy audio into our search window buffer
  if (do_add_samples) {
    ac.bufStats.attemptAdd++;
    start = 0;
    end = samples - (2 * ac.MATCH_WIN_SIZE);
    match_win = samples - ac.MATCH_WIN_SIZE;
    incr = 1;
  }
  else {
    ac.bufStats.attemptRemove++;
    start = samples - ac.MATCH_WIN_SIZE;
    end = ac.MATCH_WIN_SIZE;
    match_win = 0;
    incr = -1;
  }

  var search_idx = ac._search_for_match(swin, start, end, incr, match_win);
  if (search_idx !== -1) { // we have a match
    ac.bufStats.successes++;
    if (do_add_samples) {
      res = ac._add_samples(rxAudio, samples, swin, search_idx);
    }
    else {
      res = ac._remove_samples(rxAudio, samples, swin, search_idx);
    }
  }
  ac.bufStats.attempts++;
  ac.bufStats.successRate = ac.bufStats.successes * 100 / ac.bufStats.attempts;
  return res;
};

AudioClient.prototype._add_samples = function _add_samples(rxAudio, samples, swin, search_idx) {
  var ac = this;
  var i;
  var sample_copy_count = samples - search_idx - ac.MATCH_WIN_SIZE;
  ac.bufStats.added += sample_copy_count;

  var blendStart = rxAudio.length - ac.MATCH_WIN_SIZE;
  var addedSamples = swin.splice(search_idx + ac.MATCH_WIN_SIZE, sample_copy_count);
  rxAudio = rxAudio.concat(addedSamples);
  for (i = blendStart; i < blendStart + ac.MATCH_WIN_SIZE; i++) {
    rxAudio[i] = 0.5*(rxAudio[i]+swin[search_idx+i]);
  }
  return sample_copy_count;
};

AudioClient.prototype._remove_samples = function _remove_samples(rxAudio, samples, swin, search_idx) {
  var ac = this;
  var i;
  for (i = 0; i < ac.MATCH_WIN_SIZE; i++) {
    rxAudio[i] = 0.5 * (rxAudio[i] + swin[search_idx+i]);
  }

  var sample_shift_count = search_idx;
  ac.bufStats.removed += sample_shift_count;
  for (i = 0; i < sample_shift_count; i++) {
    rxAudio.shift(); // remove samples from the beginning
  }
  return -sample_shift_count;
};

AudioClient.prototype._search_for_match = function _search_for_match(swin, start, end, incr, match_win) {
  var ac = this;
  var i, j;
  var evl;
  var threshold = 2; //0.160; // RHK: Should we make this configurable?
  var search_idx = -1;
  for (i=start; i !== end; i+= incr) {
    evl = 0.0;
    for(j = 0; j < ac.MATCH_WIN_SIZE; j++) {
      evl += Math.abs(swin[match_win+j]-swin[i+j]);
      if (evl > threshold) {
        break;
      }
    }
    if (evl < threshold) {
      search_idx = i;
      return search_idx;
    }
  }
  return search_idx;
};

AudioClient.prototype._getOffset = function _getOffset() {
  var ac = this;
  var bufPos = ac.rxBuffer.length;
  var offset = Math.floor(bufPos - ac.MID_POINT);
  return offset;
};
