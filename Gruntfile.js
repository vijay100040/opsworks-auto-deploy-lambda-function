module.exports = function(grunt) {

  grunt.initConfig({
    jshint: {
      files: ['Gruntfile.js', 'src/**/*.js', 'test/**/*.js'],
      options: {
        globals: {
          jQuery: true
        }
      }
    },
    lambda_invoke: {
            default: {
                options: {
                    // Task-specific options go here.
                    "profile":process.env.AWS_PROFILE,
                    "region":process.env.AWS_REGION,
                    "event": "event.json"
                }
            }
    },
    lambda_package: {
            default: {
                options: {
                    // Task-specific options go here.
                    "profile":process.env.AWS_PROFILE,
                    "region":process.env.AWS_REGION,
                }
            }
    },
    lambda_deploy: {
          default: {
              options: {
                  // Task-specific options go here.
                  "profile":process.env.AWS_PROFILE,
                  "region":process.env.AWS_REGION,
              }
              ,"arn":process.env.LAMBDA_FN_ARN
          }
      }
  });
  grunt.loadNpmTasks('grunt-contrib-jshint');
  grunt.loadNpmTasks('grunt-aws-lambda');

  grunt.registerTask('default', ['jshint']);
  grunt.registerTask('deploy', ['lambda_package', 'lambda_deploy']);

};
