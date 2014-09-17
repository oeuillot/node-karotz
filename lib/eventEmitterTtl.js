var DELAY_LIMIT = 315529200000;

var EventEmitterTtl = function(configuration) {
	this._configuration = configuration || {};

	this._byTypes = {};
};
module.exports = EventEmitterTtl;

var proto = {
	removeListener: function(type, callback) {

		var listeners = this._byTypes[type];
		if (!listeners) {
			return false;
		}

		if (listeners.length === 1) {
			if (listeners[0] !== callback) {
				return false;
			}

			delete this._byTypes[type];
			return true;
		}

		var idx = listeners.indexOf(callback);
		if (idx < 0) {
			return false;
		}

		listeners.splice(idx, 1);

		return true;
	},

	on: function(type, callback, ttl) {
		if (typeof (ttl) === "number") {
			if (ttl < DELAY_LIMIT) {
				ttl += Date.now();
			}
		}

		var listeners = this._byTypes[type];
		if (!listeners) {
			listeners = [];
			this._byTypes[type] = listeners;
		}

		callback._ttl = ttl;

		listeners.push(callback);

		var self = this;
		return function() {
			self.removeListener(type, callback);
		};
	},

	once: function(type, callback, ttl) {
		var self = this;
		return this.on(type, function autoRemove() {
			self.removeListener(type, autoRemove);

			callback.apply(this, arguments);
		}, ttl);
	},

	clearListeners: function(event) {
		var args = [].slice.call(arguments);

		var byTypes = this._byTypes;
		this._byTypes = [];

		for ( var type in byTypes) {
			var listeners = byTypes[type];

			for (var i = 0; i < listeners.length; i++) {
				try {
					listeners[i].apply(this, args);

				} catch (x) {
					console.error("Exception in listener #" + i + " of event '" + type + "'", x, listeners[i]);
				}
			}
		}
	},
	emit: function(type, event) {
		var args = [].slice.call(arguments, 1);

		var listeners = this._byTypes[type];
		if (!listeners) {
			return true;
		}
		var copy = listeners.slice();

		for (var i = 0; i < copy.length; i++) {
			try {
				copy[i].apply(this, args);

			} catch (x) {
				console.error("Exception in listener #" + i + " of event '" + type + "'", x, copy[i]);
			}
		}
	},
	hasListener: function(type) {
		var listeners = this._byTypes[type];
		if (!listeners) {
			return false;
		}

		return true;
	}
};

for ( var i in proto) {
	EventEmitterTtl.prototype[i] = proto[i];
}
