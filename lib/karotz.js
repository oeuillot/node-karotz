var Util = require('util');
var EventEmitterTtl = require('./eventEmitterTtl');
var ByteBuffer = require('bytebuffer');
var uuid = require('node-uuid');
var Path = require('path');
var ProtoBuf = require('protobufjs');
var net = require('net');
var async = require('async');
var express = require('express');
var ip = require('ip');

var DEFAULT_LANG = "fr-FR";
var DEFAULT_KEEP_ALIVE = 30;
var DEFAULT_PING_DELAY = 20;

var ACTION_START = 1;
var ACTION_STOP = 2;

var CORRELATIONID_TIMEOUT = 1000 * 30;
var SOUND_TIMEOUT = 1000 * 60 * 5;
var REQUEST_TIMEOUT = 1000 * 60 * 5;

var VoosMsg = null;

var Karotz = function(configuration) {
	EventEmitterTtl.call(this);

	this._configuration = configuration || {};

	this._soundQueue = async.queue(this._processSoundQueue.bind(this), 1);
};

Util.inherits(Karotz, EventEmitterTtl);
module.exports = Karotz;

var proto = {
	open: function(callback) {
		var self = this;

		var app = express();
		this._app = app;

		app.get("/get/:correlationId", function(req, res) {
			var correlationId = req.params.correlationId;
			if (!correlationId) {
				console.log("Get no correlationId");

				res.status(404).send("No correlationId parameter");
				return;
			}

			var eventId = 'request:' + correlationId;

			if (!self.hasListener(eventId)) {
				console.error("Invalid correlationId " + eventId);
				res.status(404).send("Invalid correlationId");
				return;
			}

			console.log("Get correlationId content");

			self.emit('request:' + correlationId, res);
		});

		function openPort(port) {
			app.listen(port, function() {
				self._server = this;

				var locationURL = 'http://' + ip.address() + ':' + port;
				self._httpURL = locationURL;

				console.log("Server ready url=" + locationURL);
				self._connect(callback);
			});
		}

		var port = this._configuration.httpPort;
		if (port) {
			return openPort(port);
		}
		this._getFreePort(function(error, port) {
			if (error) {
				return callback(error);
			}

			return openPort(port);
		});

	},

	_getFreePort: function(callback) {
		var server = net.createServer();
		var port = 0;

		server.on('listening', function() {
			port = server.address().port;
			server.close();
		});

		server.on('close', function() {
			callback(null, port);
		});

		server.listen(0);
	},

	_loadVoosMessage: function(callback) {
		if (VoosMsg) {
			return callback(null, VoosMsg);
		}

		var protoPath = Path.join(__dirname, "karotz.proto");

		var self = this;

		ProtoBuf.loadProtoFile(protoPath, function(err, builder) {
			if (err) {
				callback(err);
				return;
			}

			VoosMsg = builder.build("net.violet.voos.message.VoosMsg");

			if (!VoosMsg) {
				return callback("Can not find VoosMsg");
			}

			callback(null, VoosMsg);
		});
	},

	_connect: function(callback) {

		var self = this;
		this._loadVoosMessage(function(error, VoosMsg) {
			if (error) {
				return callback(error);
			}
			self.VoosMsg = VoosMsg;

			var socket = new net.Socket();
			self._socket = socket;

			var buffer = new ByteBuffer(8000);

			socket.connect(9123, self._configuration.host, function connected(error) {
				if (error) {
					console.log("Can not connect: " + error);
					return callback(error);
				}

				socket.setKeepAlive(true, 1000 * (self._configuration.keepAlive || DEFAULT_KEEP_ALIVE));

				socket.on('data', function(data) {
					buffer.append(data);

					processMessage();
				});

				function processMessage() {
					// console.log("Mesg=", buffer);
					if (buffer.offset < 4) {
						// console.log("NO data");
						return;
					}

					buffer.flip();
					buffer.mark();
					// console.log("Begin flip buffer=", buffer);

					var size = buffer.readInt32();
					// console.log("Size=", size, buffer);
					if (size + buffer.offset > buffer.limit) {
						buffer.reset();
						buffer.flip();
						// console.log("No enough ProtoBuf=", buffer);
						return;
					}

					var protoBuf = buffer.slice(buffer.offset, buffer.offset + size);
					buffer.offset += size;
					buffer.flip();
					buffer.compact();

					// console.log("After flip buffer=", buffer);
					// console.log("ProtoBuf=", protoBuf);

					var dec;
					try {
						dec = VoosMsg.decode(protoBuf);

					} catch (x) {
						console.error("Decode error", x);

						return;
					}

					// console.log("Decode=", dec);

					setImmediate(self._processPacket.bind(self, dec));

					processMessage();
				}

				self.writeInteractiveMessage(ACTION_START, function(error, event) {
					if (error) {
						return callback(error);
					}
					if (!event.response || event.response.code !== 1) {
						return callback("Invalid communication", event.response);
					}

					callback(null);
				});

				self._pingIntervalId = setInterval(self.writePingMessage.bind(self, function(error) {
					console.log("Ping succeed !");
				}), 1000 * (self._configuration.pingDelay || DEFAULT_PING_DELAY));

				self.on('response', function(event) {
					if (event instanceof Error) {
						if (event.cause === 'CLOSE') {
							return;
						}
						console.error("Response error", event);
						return;
					}
					if (event.response.code === 1 && self.interactiveId !== event.interactiveId) {
						console.log("Set main interactive ID to " + event.interactiveId);
						self.interactiveId = event.interactiveId;
						return;
					}
				});
			});
		});
	},

	_processPacket: function(packet) {
		if (packet.event) {
			this._processEventPacket(packet);
		}
		if (packet.response) {
			this._processResponsePacket(packet);
		}

		if (packet.correlationId) {
			this.emit('correlationId:' + packet.correlationId, packet);
		}
	},

	_processEventPacket: function(event) {
		// console.log("Event", event);
		this.emit('event', event);
	},

	_processResponsePacket: function(event) {
		// console.log("Response", event);
		this.emit('response', event);
	},

	writeMessage: function(message, callback) {
		if (this._closed) {
			return callback(new Error("Connexion is closed !"));
		}

		if (!message.id) {
			message.id = uuid.v4();
		}

		if (this.interactiveId) {
			message.interactiveId = this.interactiveId;
		}

		// console.log("Write message", message);

		var msgBuffer = message.toBuffer();

		var bb = new ByteBuffer(4 + msgBuffer.length);
		bb.writeInt32(msgBuffer.length);
		bb.append(msgBuffer);
		bb.flip();
		var buffer = bb.toBuffer();

		// console.log("Send buffer", buffer);

		this._socket.write(buffer, callback);
	},
	writeInteractiveMessage: function(action, callback) {

		var interactiveId = uuid.v4();

		var interactiveMessage = new this.VoosMsg({
			interactiveMode: {
				interactiveId: interactiveId,
				action: action || 1
			}
		});

		var self = this;
		this.writeMessage(interactiveMessage, function(error) {
			if (error) {
				return callback(error);
			}

			self.once('correlationId:' + interactiveMessage.id, function(event) {
				if (event instanceof Error) {
					return callback(event);
				}
				callback(null, event);
			}, CORRELATIONID_TIMEOUT);
		});
	},
	writePingMessage: function(callback) {

		var pingMessage = new this.VoosMsg({
			ping: {}
		});

		var self = this;
		this.writeMessage(pingMessage, function(error) {
			if (error) {
				return callback(error);
			}

			self.once('correlationId:' + pingMessage.id, function(event) {
				if (event instanceof Error) {
					return callback(event);
				}
				callback(null, event);
			}, CORRELATIONID_TIMEOUT);
		});
	},

	startTts: function(text, lang, callback) {

		if (typeof (lang) === "function") {
			callback = lang;
			lang = null;
		}

		var voosMessage = new this.VoosMsg({
			tts: {
				action: 1,
				text: text,
				lang: lang || this._configuration.lang || DEFAULT_LANG
			}
		});

		this._soundQueue.push({
			text: text,
			lang: lang,
			callback: callback,
			voosMessage: voosMessage
		});
	},

	stopSound: function(callback) {
		this._soundQueue.kill();

		var voosMessage = new this.VoosMsg({
			multimedia: {
				stop: {}
			}
		});

		var self = this;
		this.writeMessage(voosMessage, function(error) {
			if (error) {
				return callback(error);
			}

			self.once('correlationId:' + voosMessage.id, function(event) {
				if (event instanceof Error) {
					return callback(event);
				}
				callback(null, event);
			}, CORRELATIONID_TIMEOUT);
		});

	},

	playSound: function(bufferOrFile, callback) {

		var self = this;
		var id = uuid.v4();

		var voosMessage = new this.VoosMsg({
			id: id,
			multimedia: {
				play: {
					url: self._httpURL + "/get/" + id
				}
			}
		});

		this.once("request:" + id, function(response) {
			if (response instanceof Error) {
				console.error("Request error", response);
				return;
			}

			// Send buffer !
			if (Buffer.isBuffer(bufferOrFile)) {
				response.write(bufferOrFile);
				return;
			}

			if (typeof (bufferOrFile) === "string") {
				// console.log("Send file " + bufferOrFile);
				response.sendFile(bufferOrFile);
				return;
			}

			console.error("Invalid data format", bufferOrFile);

			response.status(500).send("Invalid data format");

		}, REQUEST_TIMEOUT);

		this._soundQueue.push({
			callback: callback,
			voosMessage: voosMessage
		});
	},

	_processSoundQueue: function(msg, callback) {
		console.log("Process", msg);

		var voosMessage = msg.voosMessage;

		var self = this;
		this.writeMessage(voosMessage, function(error) {
			if (error) {
				if (msg.destroy) {
					msg.destroy();
				}
				setTimeout(callback, 1000);
				return msg.callback(error);
			}

			function waitMessage(event) {
				if (event instanceof Error) {
					if (msg.destroy) {
						msg.destroy();
					}
					setTimeout(callback, 1000);
					return msg.callback(event);
				}
				console.log("Event=", event);

				if (event.response) {
					if (event.response.code === 1) {
						msg.received = true;
						self.once('correlationId:' + voosMessage.id, waitMessage, SOUND_TIMEOUT);
						return;
					}
				}

				if (msg.destroy) {
					msg.destroy();
				}
				setTimeout(callback, 1000);

				if (event.event) {
					if (event.event.code === 4) {
						return msg.callback(null);
					}
				}

				msg.callback("Unknown event " + event);
			}

			self.once('correlationId:' + voosMessage.id, waitMessage, CORRELATIONID_TIMEOUT);
		});
	},

	stopTts: function(callback) {
		this._soundQueue.kill();

		var voosMessage = new this.VoosMsg({
			tts: {
				action: 2
			}
		});

		var self = this;
		this.writeMessage(voosMessage, function(error) {
			if (error) {
				return callback(error);
			}

			self.once('correlationId:' + voosMessage.id, function(event) {
				if (event instanceof Error) {
					return callback(event);
				}
				callback(null, event);
			}, CORRELATIONID_TIMEOUT);
		});

	},

	close: function(immediatly, callback) {
		if (typeof (immediatly) === "function") {
			callback = immediatly;
			immediatly = true;
		}

		if (this._closed) {
			return callback("Already closed");
		}

		clearInterval(this._pingIntervalId);
		delete this._pingIntervalId;

		var self = this;

		this.writeInteractiveMessage(ACTION_STOP, function(error, event) {

			self._socket.end();

			self._socket.on('close', function() {
				delete self._socket;

				self._server.close(function(error) {
					delete self._server;
					if (error) {
						console.error("Can not close express server", error);
					}

					if (callback) {
						callback(null);
					}
				});

			});

		});

		this._closed = true;

		var err = new Error("Close connexion");
		err.cause = "CLOSE";
		this.clearListeners(err);
	}

};

for ( var i in proto) {
	Karotz.prototype[i] = proto[i];
}
