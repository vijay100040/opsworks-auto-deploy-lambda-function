var _ = require("underscore");
_.mixin(require("underscore.deep"));
var parse = require("path-parse");
var fs = require("fs");
var strformat = require("strformat");

module.exports = function (configFile) {
	var settings = {};
	var splinters = parse(configFile);
	var files = [
		"{dir}/all{ext}",
		"{dir}/{name}{ext}",
		"{dir}/{name}.specific{ext}",
		"{dir}/{name}.local{ext}"
	];
	for (var fileIndex in files) {
		var filePath = strformat(files[fileIndex], splinters);
		if (fs.existsSync(filePath)) {
			settings = _.deepExtend(settings, JSON.parse(fs.readFileSync(filePath, {
				encoding: "UTF-8"
			})));
		}
	}
	return settings;
};
