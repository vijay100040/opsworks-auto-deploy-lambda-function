var helper = require("./helper.js");
var async = require("async");
var dbHandler = require("./db_handler.js");
var targetEnvSetHelper = require("./target_envset_helper.js");
var moment = require("moment");
var logger = helper.logger;

module.exports = function (message, config, context) {
	var s3 = helper.s3;
	var opsworks = helper.opsworks;
	var jobData = {};
	jobData.config = config;
	jobData.dbUpdated = false;
	jobData.deploymentId = "NEW";
	var locked = false;

	function validateDeploymentStatus(jobData, command, callback) {
		dbHandler.getDeploymentStatus(jobData.config.appName, function (err, data) {
			if (err) {
				return callback(err);
			}

			var deploymentStatus = data.deployment_status;

			var allowProgress = false;
			// Allow pipeline to begin if this command first in pipeline and pipeline is NOT already in progress
			if (helper.DEPLOYMENT_COMMAND_SEQ.indexOf(command) === 0) {
				if (data.pipeline_status == helper.STATUS_NOTRUNNING) {
					allowProgress = true;
				}
			} else if (data.pipeline_status == helper.STATUS_RUNNING) {
				// Allow pipeline to progress if pipeline is already in progress and the command is not the trigger
				// This is OK since the trigger is the only point we need to control. Everything else is programatically decided
				if (data.last_command === command) {
					logger.debug("The command %s was already started. Skipping.", command);
				} else {
					allowProgress = true;
				}
			}
			allowProgress = allowProgress || jobData.config.overrideStatusCheck == 1;

			if (!allowProgress) {
				var startDate = moment(data.last_updated_datetime, "x");
				var endDate = moment();
				var minsElapsedSinceLastUpdate = endDate.diff(startDate, "minutes");
				if (minsElapsedSinceLastUpdate >= config.deploymentTimeout) {
					// The deployment has not been possibly monitored to be closed. Maybe we can allow this to pass through.
				}

				var error = new Error("Invalid State: Skipping deployment. Current Status " + deploymentStatus);
				error.subtype = "skip_deployment";
				return callback(error, data);
			}

			callback(null, data);
		});
	}

	function getArtifactMetadata(jobData, resultCallback) {
		var fnConfig = jobData.config;

		// We pickup only the latest versions of artifacts for deployment.
		async.forEachOf(fnConfig.submodules,
			function (item, key, callback) {
				var params = {
					Bucket: fnConfig.artifactBucket,
					Key: item.archiveName
				};

				s3.headObject(params, function (err, data) {
					if (err) return callback(err); // an error occurred
					else {
						fnConfig.submodules[key].versionId = data.VersionId;
						if (data.Metadata && data.Metadata.commit_id) {
							fnConfig.submodules[key].lastCommitId = data.Metadata.commit_id;
						}
						callback(null);
					}
				});
			},
			function (err) {
				if (err) return resultCallback(err);
				resultCallback(null, fnConfig);
			});
	}

	function beginDeployment(command, targetEnvConfig, callback) {
		// Begins an OpsWorks deployment or executes one or more recipes
		// Each deployment execution is monitored using a SNS topic and delivery to "monitorDeployment" function

		var params = {};
		params.StackId = config.opsWorksStackId;
		params.CustomJson = JSON.stringify(targetEnvConfig.customJson);
		params.InstanceIds = targetEnvConfig.targetEnvInstanceIds;
		params.Comment = command;

		if (command == "deploy") {
			params.AppId = config.opsWorksAppId;
			params.Command = {
				Name: command
			};
		} else {
			params.Command = {
				Name: "execute_recipes",
				Args: {
					"recipes": targetEnvConfig.commandSpec.recipes
				}
			};
		}

		opsworks.createDeployment(params, function (err, data) {
			if (err) {
				logger.warn("Deployment to OpsWorks failed. {%s}", err);
				return callback(err);
			}
			logger.info("OpsWorks deployment %s triggered for command %s. ", data.DeploymentId, command);
			return callback(null, data);
		});
	}

	var updateParams = {};
	updateParams.deploymentStatus = helper.buildPipelineStatus(message.command, helper.STATUS_INPROGRESS);
	updateParams.pipelineStatus = helper.STATUS_RUNNING;
	updateParams.lastDeploymentId = jobData.deploymentId;
	updateParams.lastCommand = message.command;

	async.waterfall([
			function (callback) {
				logger.info("Processing handle message for command %s", message.command);
				dbHandler.acquireLock(jobData.config.appName, "handleDeployment", callback);
			},
			function (callback) {
				locked = true;

				getArtifactMetadata(jobData, function (err, result) {
					if (err) return callback(err);
					jobData.config = result;
					callback(null, jobData);
				});
			},
			function (jobData, callback) {
				validateDeploymentStatus(jobData, message.command, function (err, result) {
					if (err && err.subtype && err.subtype == "skip_deployment") {
						var options = {};
						options.deploymentQueuedFlag = true;
						options.currentVersion = result.item_version;

						dbHandler.updateDeploymentStatus(jobData.config.appName, options, function () {
							callback(err, result);
						});
					} else {
						callback(err, result);
					}
				});
			},
			function (data, callback) {
				jobData.lastVersionId = data.item_version;
				updateParams.currentVersion  = jobData.lastVersionId;
				if (helper.DEPLOYMENT_COMMAND_SEQ.indexOf(message.command) === 0) {
					updateParams.deploymentQueuedFlag = false;
					updateParams.totalDeploymentsCountIncrement = 1;
					updateParams.deploymentBeginDatetime = Date.now();
				}
				dbHandler.updateDeploymentStatus(jobData.config.appName, updateParams, callback);
			},
			function (callback) {
				jobData.dbUpdated = true;
				jobData.lastVersionId++;
				targetEnvSetHelper(jobData, message, context, callback);
			},
			function (targetEnvConfig, callback) {
				beginDeployment(message.command, targetEnvConfig, function (err, result) {
					helper.publishMonitorMessage(config.monitoringTopicArn, "monitorDeployment", message.command, result.DeploymentId, function (err) {
						if (err) return callback(err);
						callback(null, result);
					});
				});
			},
			function (data, callback) {
				updateParams.lastDeploymentId = data.DeploymentId;
				updateParams.currentVersion  = jobData.lastVersionId;

				dbHandler.updateDeploymentStatus(jobData.config.appName, updateParams, callback);
			},
			function (callback) {
				dbHandler.releaseLock(jobData.config.appName, "handleDeployment", callback);
				locked = false;
			}
		],
		function (err) {
			if (err) {
				logger.debug("error", err);
				if (jobData && jobData.dbUpdated) {
					updateParams.deploymentStatus  = helper.buildPipelineStatus(message.command, helper.STATUS_FAILED);
					updateParams.failedDeploymentsCountIncrement = 1;
					updateParams.deploymentEndDatetime = Date.now();

					updateParams.currentVersion  = jobData.lastVersionId;
					updateParams.pipelineStatus = helper.STATUS_NOTRUNNING;
					updateParams.lastDeploymentId = jobData.deploymentId;
					dbHandler.updateDeploymentStatus(jobData.config.appName, updateParams,  helper.noopCallback);
				}
			}
			if (locked) {
				dbHandler.releaseLock(jobData.config.appName, "handleDeployment", function () {
					if (err) {
						if (err.subtype && err.subtype == "skip_deployment") {
							context.succeed();
							return;
						}
						logger.warn("handleDeployment: Marking a failure. This may cause retries of the operation %s , err %s", message.command, err);
						context.fail(err);
						return;
					}
				});
			} else {
				context.succeed();
			}
		}
	);
};
