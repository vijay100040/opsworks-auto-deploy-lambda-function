var settingsLoader = require("./lib/settings.js");
var settings = settingsLoader("./settings/prod.json");
var loggerLoader = require("./lib/logger.js");

var logger = loggerLoader(settings);

// require("dotenv").load();
// var logger = require("winston");
// logger.level = "debug";
// logger.remove(logger.transports.Console);
// logger.add(logger.transports.Console, {"timestamp":true});
// logger.add(logger.transports.Console, {"timestamp":true});

var actions = {
	"handleDeployment": require("./lib/handle_deployment.js"),
	"monitorDeployment": require("./lib/monitor_deployment.js")
};

var config = settings;


exports.handler = function (event, context) {

	if (event.Records[0].Sns) {
		var message = JSON.parse(event.Records[0].Sns.Message);
		if (!message.command) {
			message.command = "deploy";
		}
		if (!message.action && message.Records) {
			var s3 = message.Records[0].s3;
			if (s3) {
				if (s3.configurationId == "ArtifactUploaded") {
					message.action = "handleDeployment";
					message.command = "prepare_staging";
					message.source = "snap CI";
				} else {
					message.source = "manual";
				}
			}
		}
		// Skip processing monitoring call, if it"s disabled in the configuration
		if (message.action === "monitorDeployment" && !config.monitoringEnabled) {
			logger.debug("Skipped processing message : %s", JSON.stringify(event, null, 2));
			context.succeed();
			return;
		}
		if (message.overrideStatusCheck) {
			config.overrideStatusCheck = message.overrideStatusCheck;
		}

		config.topicArn = event.Records[0].Sns.TopicArn;
		config.messageSent = Date.parse(event.Records[0].Sns.Timestamp);
		var targetAction = actions[message.action];
		targetAction(message, config, context);

		return;
	}
};
