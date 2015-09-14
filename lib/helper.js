var settingsLoader = require("./settings.js");
var settings = settingsLoader("./settings/prod.json");
var loggerLoader = require("./logger.js");

var logger = loggerLoader(settings);

var AWS = require("aws-sdk");

AWS.config.update({
	region: "us-east-1",
	apiVersions: {
		s3: "2006-03-01"
	},
	S3Config: {
		UseSignatureVersion4: true
	}
});
var exp = {};

exp.opsworks = new AWS.OpsWorks();
exp.s3 = new AWS.S3({
	signatureVersion: "v4"
});
exp.sns = new AWS.SNS();
var doc = require("dynamodb-doc");

exp.dynamo = new doc.DynamoDB();

exp.NOTIFY_STATUSES_REGEXP = [".*failed$"];
exp.STATUS_INPROGRESS = "inprogress";
exp.STATUS_RUNNING = "running";
exp.STATUS_NOTRUNNING = "not_running";
exp.STATUS_HALTED = "halted";
exp.STATUS_FAILED = "failed";
exp.STATUS_SUCCESSFUL = "successful";
exp.COMMAND_HALT_PIPELINE = "__HALT_PIPELINE__";

exp.COMMANDS = [{
	"command": "prepare_staging",
	"recipes": ["blue_green_deploy::kill_containers", "blue_green_deploy::prepare_staging"],
	"targetLayerTypes": ["app_frontend", "app_backend"],
	"onfailCommand": "",
	"sendCustomJson": true
}, {
	"command": "deploy",
	"recipes": [],
	"targetLayerTypes": ["load-balancer", "app_frontend", "app_backend"],
	"onfailCommand": "",
	"sendCustomJson": true
}, {
	"command": "test_staging",
	"recipes": ["blue_green_deploy::run_tests"],
	"targetLayerTypes": ["load-balancer"],
	"onfailCommand": "",
	"sendCustomJson": false
}, {
	"command": "prepare_stg_for_prod",
	"recipes": ["blue_green_deploy::prepare_stg_for_prod"],
	"targetLayerTypes": ["app_frontend", "app_backend"],
	"onfailCommand": "rollback_staging",
	"sendCustomJson": true
}, {
	"command": "switch_to_prod",
	"recipes": ["blue_green_deploy::switch_to_prod"],
	"targetLayerTypes": ["load-balancer"],
	"onfailCommand": "rollback_staging",
	"sendCustomJson": false
}, {
	"command": "cleanup",
	"recipes": ["blue_green_deploy::kill_old_containers"],
	"targetLayerTypes": ["app_frontend", "app_backend"],
	"onfailCommand": "",
	"sendCustomJson": true
}, {
	"command": "rollback_staging",
	"recipes": ["blue_green_deploy::rollback_staging"],
	"targetLayerTypes": ["app_frontend", "app_backend"],
	"onfailCommand": exp.COMMAND_HALT_PIPELINE,
	"sendCustomJson": false
}];
exp.COMMANDS_IN_PIPELINE = [
	"prepare_staging",
	"deploy",
	"test_staging",
	"prepare_stg_for_prod",
	"switch_to_prod",
	"cleanup"
];
exp.logger = logger;

function printCallback(err, data) {
	if (err) {
		logger.error(err, err.stack);
	} else {
		if (data) {
			logger.debug("data : {%s}, jsonData : {%s}", data, JSON.stringify(data));
		}
	}
}

function noopCallback() {
	// Do nothing.
}

function findByCommand(source, command) {
	return source.filter(function (obj) {
		return obj.command === command;
	})[0];
}

function findByModuleName(source, moduleName) {
	return source.filter(function (obj) {
		return obj.module === moduleName;
	})[0];
}

function buildPipelineStatus(command, status) {
	return [command, status].join("__");
}

function isNotificationRequired(notificationPatterns, pipelineStatus) {
	return new RegExp(notificationPatterns.join("|")).test(pipelineStatus);
}

function publishMonitorMessage(topicArn, action, command, deploymentId, callback) {
	var notificationMessage = JSON.stringify({
		action: action,
		deploymentId: deploymentId,
		command: command
	});

	var params = {
		Message: notificationMessage,
		Subject: "Monitor OpsWorks Deployment",
		TargetArn: topicArn
	};
	exp.sns.publish(params, callback);
}
exp.noopCallback = noopCallback;
exp.printCallback = printCallback;
exp.isNotificationRequired = isNotificationRequired;
exp.findByCommand = findByCommand;
exp.publishMonitorMessage = publishMonitorMessage;
exp.buildPipelineStatus = buildPipelineStatus;
exp.printCallback = printCallback;
exp.noopCallback = noopCallback;
exp.findByModuleName = findByModuleName;

module.exports = exp;
