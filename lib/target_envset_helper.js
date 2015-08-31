var async = require("async");
var http = require("http");
var contextHolder = require("./app_context_holder.js");
var utils = require("./utils.js");
var logger = require("winston");

module.exports = function (jobData, message, context, fnCallback) {
	var opsworks = contextHolder.opsworks;
	var jobConfig = jobData.config;

	function getCurrentUpstreamInstances(config, callback) {
		var options = {
			host: config.lbHost,
			port: config.lbUpstreamPort,
			path: "/upstream",
			headers: {
				"Authorization": "Basic " + new Buffer(config.lbUpstreamUser + ":" + config.lbUpstreamPassword).toString("base64")
			}
		};
		http.get(options, function (res) {
			res.on("data", function (chunk) {
				callback(null, JSON.parse(chunk));
			});
		}).on("error", function (e) {
			callback(e);
		});
	}

	function getLayerForInstances(instances, upstreamData, layerData, callback) {
		if (!(upstreamData && upstreamData.servers)) {
			return;
		}

		instances.forEach(function (item) {
			var publicDns = item.PublicDns;
			if (upstreamData.servers.indexOf(publicDns) >= 0) {
				// logger.debug("instance layer %s %s", publicDns, item.LayerIds);
				if (item.LayerIds.length > 1) {
					callback(new Error("Invalid State: We don't allow more than one layer per instance"));
					return;
				}
				var layerId = item.LayerIds[0];
				if (!upstreamData.layerId) {
					upstreamData.layerId = layerId;
					// logger.debug("instance layer ID %s %s", publicDns, upstreamData.layerId);
				} else if (upstreamData.layerId != layerId) {
					logger.debug("Invalid State: Two instances in different layers. L1: %s L2:%s IP:%s", upstreamData.layerId, layerId, publicDns);
					callback(new Error("Invalid State: Two instances that are part of a deployment environment are in different layers."));
					return;
				}
			}
		});
		var matchingLayers = layerData.filter(function (item) {
			return item.LayerId == upstreamData.layerId;
		});
		if (matchingLayers && matchingLayers.length == 1) {
			upstreamData.layerName = matchingLayers[0].Name;
			upstreamData.layerShortName = matchingLayers[0].Shortname;
			var layerParts = upstreamData.layerShortName.split("_");
			if (layerParts.length != 3) {
				callback(new Error("Invalid State: Layer has to be named app_<Blue/Green>_<frontend/backend>"));
			}
			upstreamData.productionEnvSet = layerParts[1];
		} else {
			callback(new Error("Invalid State: Unable to match production layer '" + upstreamData.layerId + "' with instances. Verify Upstream config"));
		}

		callback(null, upstreamData);
	}

	function getStackInstances(stackID, callback) {
		var params = {
			StackId: stackID
		};
		opsworks.describeInstances(params, function (err, data) {
			if (err) {
				logger.debug("Could not list instances." + err);
				callback(err);
				return;
			}

			callback(null, data.Instances);
		});
	}

	function getLayers(stackID, callback) {
		var params = {
			StackId: stackID
		};
		opsworks.describeLayers(params, function (err, data) {
			if (err) {
				logger.debug("Could not list layers.", err);
				callback(err);
				return;
			}
			callback(null, data.Layers);
		});
	}

	function getLayerInstances(instances, layers, targetLayers) {
		var matchingLayerIds = layers.filter(function (layer) {
			return (targetLayers.indexOf(layer.Shortname) >= 0);
		}).map(function (layer) {
			return layer.LayerId;
		});
		var layerInstanceIds = instances.filter(function (item) {
			return (matchingLayerIds.indexOf(item.LayerIds[0]) >= 0);
		}).map(function (instance) {
			return instance.InstanceId;
		});
		return layerInstanceIds;
	}

	function decideTargetEnvSet(config, message, instances, layers, productionEnvSet) {
		var targetEnvConfig = {};
		var targetLayers = [];
		var customJson = {};

		// Decide target deployment environment based on production.
		if (productionEnvSet == "green") {
			targetEnvConfig.targetEnvSet = "blue";
		} else if (productionEnvSet == "blue") {
			targetEnvConfig.targetEnvSet = "green";
		}
		targetEnvConfig.commandSpec = utils.findByCommand(contextHolder.COMMANDS, message.command);

		if (targetEnvConfig.commandSpec.sendCustomJson) {
			var AUTODEPLOY_CONFIG = "submodules";
			customJson[AUTODEPLOY_CONFIG] = {};
		}
		var appPrefix = "app_";

		targetEnvConfig.commandSpec.targetLayerTypes.forEach(function (layer) {
			var layerName = "";
			if (layer.slice(0, appPrefix.length) == appPrefix) {
				// This is an app layer, do special handling.
				var app = layer.slice(appPrefix.length, layer.length);
				layerName = ["app", targetEnvConfig.targetEnvSet, app].join("_");

				if (targetEnvConfig.commandSpec.sendCustomJson) {
					customJson[AUTODEPLOY_CONFIG][app] = {
						"layer": layerName
					};

					var moduleConfig = utils.findByModuleName(config.submodules, app);
					if (moduleConfig && moduleConfig.versionId) {
						customJson[AUTODEPLOY_CONFIG][app].version_id = moduleConfig.versionId;
					}

					if (app == "frontend") {
						customJson.layer = layerName;
					}
				}
			} else {
				layerName = layer;
			}
			targetLayers.push(layerName);
		});

		targetEnvConfig.targetEnvLayers = targetLayers;
		targetEnvConfig.targetEnvInstanceIds = getLayerInstances(instances, layers, targetLayers);
		targetEnvConfig.customJson = customJson;

		return targetEnvConfig;
	}
	// These calls are external IO and don't have dependency on each other.
	async.parallel({
			"upstreamData": getCurrentUpstreamInstances.bind(null, jobData.config),
			"instances": getStackInstances.bind(null, jobConfig.opsWorksStackId),
			"layerData": getLayers.bind(null, jobConfig.opsWorksStackId)
		},
		function (err, results) {
			if (err) {
				return fnCallback(err);
			}
			// These calls have dependency on the results of previous call.
			async.waterfall([
					function (callback) {
						getLayerForInstances(results.instances, results.upstreamData.production, results.layerData, callback);
					},
					function (data, callback) {

						var targetEnvConfig = decideTargetEnvSet(jobConfig, message, results.instances, results.layerData, results.upstreamData.production.productionEnvSet);
						callback(null, targetEnvConfig);
					}
				],
				function (err, targetEnvConfig) {
					if (err) {
						return fnCallback(err);
					} else {
						results.customJson = targetEnvConfig.customJson;

						fnCallback(null, targetEnvConfig);
					}
				});
		});
};
