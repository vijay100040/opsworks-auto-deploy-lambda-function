
var AWS = require('aws-sdk');
var async = require('async');
var http = require('http');
var contextHolder = require('./app_context_holder.js');

module.exports = function (message, config, context, fnCallback) {
    var opsworks = contextHolder.opsworks;

    var getCurrentUpstreamInstances = function (config, callback) {
          var options = {
            host: config.lbHost
            , port: config.lbUpstreamPort
            , path: '/upstream'
            , headers: {'Authorization': 'Basic ' + new Buffer(config.lbUpstreamUser + ':' + config.lbUpstreamPassword).toString('base64')}
          };
          http.get(options, function(res) {
            res.on('data', function (chunk) {
              callback(null, JSON.parse(chunk))
            });
          }).on('error', function(e) {
            callback(e);
          });
    }

    var getLayerForInstances = function(instances, upstreamData, layerData, callback) {
        var returnArr = [];
        if(!(upstreamData && upstreamData.servers)) {
          return;
        }

        instances.forEach(function(item) {
          var publicDns = item.PublicDns;
          if(upstreamData.servers.indexOf(publicDns) > 0) {
            var layerId = item.LayerIds;
            if(layerId.length > 1) {
              callback(new Error("Invalid State: We don't allow more than one layer per instance"));
              return;
            }
            if(!upstreamData.layerId) {
              upstreamData.layerId = layerId;
            }else if(upstreamData.layerId != layerId) {
              callback(new Error("Invalid State: Two instances that are part of a deployment environment are in different layers."));
              return;
            }
          }
      });
      var matchingLayers = layerData.filter(function(item) {
        return item.LayerId == upstreamData.layerId;
      });
      if(matchingLayers && matchingLayers.length == 1) {
        upstreamData.layerName = matchingLayers[0].Name;
        upstreamData.layerShortName = matchingLayers[0].Shortname;
        var layerParts = upstreamData.layerShortName.split('_');
        if(layerParts.length != 3) {
          callback(new Error("Invalid State: Layer has to be named app_<Blue/Green>_<frontend/backend>"));
        }
        upstreamData.productionEnvSet = layerParts[1];
      } else {
        callback(new Error("Invalid State: More than one layer found per id"));
      }

      callback(null, upstreamData);
    }

    var getStackInstances = function(stackID,  callback) {
        var params = {StackId: stackID};
        opsworks.describeInstances(params, function(err, data) {
            if(err) {
                console.log('Could not list instances.' + err);
                callback(err);
                return;
            }

            callback(null, data.Instances);
        });
    }

    var getLayers = function(stackID, callback) {
      var params = {StackId: stackID};
      opsworks.describeLayers(params, function(err, data) {
            if(err) {
                console.log('Could not list layers.', err);
                callback(err);
                return;
            }
            callback(null, data.Layers);
        });
    }

    var getLayerInstances = function(instances, layers, targetLayers, callback) {
        var matchingLayerIds = layers.filter(function(layer) {
          return (targetLayers.indexOf(layer.Shortname) >= 0);
        }).map(function(layer) {
            return layer.LayerId;
        });
        var layerInstanceIds = instances.filter(function(item) {
          return (matchingLayerIds.indexOf(item.LayerIds[0]) >= 0);
        }).map(function(instance) {
          return instance.InstanceId;
        });
        return layerInstanceIds;
    }
    var decideTargetEnvSet = function (config, message, instances, layers, productionEnvSet) {
      // Decide target deployment environment based on production.
      if(productionEnvSet =='green') {
        targetEnvSet = 'blue';
      } else if(productionEnvSet =='blue') {
        targetEnvSet = 'green';
      }
      // Set the Layers to which deployment will be done.
      var targetLayers = ['load-balancer'];
      var frontendApp = '';
      var customJson = {};
      var AUTODEPLOY_CONFIG = "blue_green_deploy";
      customJson.env = "stage";
      customJson[AUTODEPLOY_CONFIG] = {};
      config.submodules.forEach(function(item) {
          layerName = ["app",targetEnvSet,item.module].join('_');
          targetLayers.push(layerName);
          customJson[AUTODEPLOY_CONFIG][item.module] = {"layers":layerName};

          if(item.module == "frontend") {
            customJson.layer = layerName;
          }
      });


      var targetEnvConfig = {};
      targetEnvConfig.targetEnvSet = targetEnvSet;
      targetEnvConfig.targetEnvLayers = targetLayers;
      targetEnvConfig.targetEnvInstanceIds = getLayerInstances(instances, layers, targetLayers);
      targetEnvConfig.customJson = customJson;

      return targetEnvConfig;
    }
    // These calls are external IO and don't have dependency on each other.
    async.parallel({
      "upstreamData" : getCurrentUpstreamInstances.bind(null,config)
      , "instances" : getStackInstances.bind(null,config.opsWorksStackId)
      , "layerData" : getLayers.bind(null,config.opsWorksStackId)
    },
    function(err, results) {
        if(err) {
          return fnCallback(err);
        }
        // These calls have dependency on the results of previous call.
        async.waterfall([
            function (callback) {
               getLayerForInstances(results.instances, results.upstreamData.production, results.layerData, callback);
            },
            function (data, callback) {

               targetEnvConfig = decideTargetEnvSet(config, message, results.instances, results.layerData, results.upstreamData.production.productionEnvSet);
               callback(null, targetEnvConfig )
            }],
            function (err, targetEnvConfig) {
              if(err) {
                return fnCallback(err);
              } else {
                results.customJson = targetEnvConfig.customJson;

                fnCallback(null, targetEnvConfig);
              }
        });
    });
}
