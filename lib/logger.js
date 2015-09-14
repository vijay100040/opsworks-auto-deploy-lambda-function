var winston = require("winston");
require("winston-loggly");

module.exports = function (settings) {
	winston.addColors({
		verbose: "green"
	});

	var transports = [];
	Object.keys(settings.logger.transports).forEach(function (key) {
		var transportConfig = settings.logger.transports[key];
		var transport = new(winston.transports[key])(transportConfig);
		transports.push(transport);
	});

	var logger = new winston.Logger({
		transports: transports
	});

	return logger;
};
