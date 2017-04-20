var gulp = require('gulp'),
    gutil = require('gulp-util'),
    _ = require('lodash'),
    archiver = require('archiver'),
    through = require('through2'),
    buffer = require('vinyl-buffer'),
    source = require('vinyl-source-stream'),
    needle = require("needle"),
    wrapNeedle = require("../util/wrap-needle"),
    read = require("read");

function responseHandler(name, taskRefs, success, error) {
  error = error || taskRefs.done;

  return function (err, resp, body) {
    if (!err && (resp.statusCode >= 200 && resp.statusCode < 400)) {
      taskRefs.log.ok(name + " successful (HTTP " + resp.statusCode + ")");
      success(resp, body);
    } else if (err) {
      taskRefs.log.fail(name + " failed:");
      taskRefs.log.error("Message: " + err);
      error(new Error(err));
    } else {
      taskRefs.log.fail(name + " failed (HTTP " + resp.statusCode + ")");
      taskRefs.log.error("Message: " + body.error);
      error(new Error(body.error));
    }
  }
}

function start(taskRefs) {
  var uploadHandler = responseHandler("Upload", taskRefs, function (response, body) {
    if (!taskRefs.options.appId){
      var appId = body.id;
      taskRefs.options.appId = appId;
      taskRefs.log.warn("APPID: " + appId);
    }

    var buildHandler = responseHandler("Build", taskRefs, function () {
        if (taskRefs.options.download) downloadApps(taskRefs, taskRefs.done);
        else taskRefs.done();
    });

    //There is a bug in PhoneGap Build API that doesn't allow to trigger build for all platforms
    if (!taskRefs.options.platforms) {
        taskRefs.log.warn("Target platform(s) is not specified.");
    }

    var config = {
        multipart: true
    };
    var data = {
        platforms: taskRefs.options.platforms || []
    };
    var postData = {data: JSON.stringify(data)};
    taskRefs.needle.post('/api/v1/apps/'  + taskRefs.options.appId + '/build', postData, config, buildHandler);
  });

  taskRefs.needle = wrapNeedle("https://build.phonegap.com", taskRefs.options);

  if (taskRefs.options.keys && taskRefs.options.appId) {
    unlockKeys(taskRefs, uploadZip.bind(null, taskRefs, uploadHandler));
  } else {
    uploadZip(taskRefs, uploadHandler);
  }
}

function unlockKeys(taskRefs, callback) {
  taskRefs.needle.get('/api/v1/apps/' + taskRefs.options.appId, null,
      responseHandler("Get keys", taskRefs, function (response, body) {
        var keys = body.keys,
            platformsUnlockable = Object.keys(taskRefs.options.keys),
            numUnlockable = platformsUnlockable.length;

        function unlocked() {
          if (--numUnlockable === 0) callback();
        }

        platformsUnlockable.forEach(function (platform) {
          var buildInfo = keys[platform];

          if (buildInfo) {
            taskRefs.needle.put(keys[platform].link, { data: taskRefs.options.keys[platform] }, null,
                responseHandler("Unlocking " + platform, taskRefs, unlocked, unlocked));
          } else {
            taskRefs.log.warn("No key attached to app for " + platform);
            unlocked();
          }
        });
      })
  );
}

function uploadZip(taskRefs, callback) {
    var config = { },
        data ={}

    var appTitle = (typeof taskRefs.options.title != 'undefined' ? taskRefs.options.title : "App title");
    data.data = {
        title : appTitle
    }
    if (typeof taskRefs.options.hydrates != 'undefined') {
        data.data.hydrates = taskRefs.options.hydrates;
    }
    if (typeof taskRefs.options.private != 'undefined') {
        data.data.private = taskRefs.options.private;
    }
    if (typeof taskRefs.options.debug != 'undefined') {
        data.data.debug = taskRefs.options.debug;
    }
    if (typeof taskRefs.options.share != 'undefined') {
        data.data.share = taskRefs.options.share;
    }
    if (typeof taskRefs.options.version != 'undefined') {
        data.data.version = taskRefs.options.version;
    }
    if (typeof taskRefs.options.phonegap_version != 'undefined') {
        data.data.phonegap_version = taskRefs.options.phonegap_version;
    }

    if (taskRefs.options.isRepository) {
        data.data.pull = true;
        data.data.create_method = 'remote_repo';
    } else {
        data.data.create_method = 'file';
        data.file = {
            buffer: taskRefs.archive,
            filename: 'app.zip',
            content_type: 'application/octet-stream'
        }
        config.multipart = true;
        config.timeout = taskRefs.options.timeout;
    }

    taskRefs.log.ok("Starting upload");
  if(taskRefs.options.appId)
    taskRefs.needle.put('/api/v1/apps/' + taskRefs.options.appId, data, config, callback);
  else
    taskRefs.needle.post('/api/v1/apps/', data, config, callback)
}

function downloadApps(taskRefs, callback) {
  var platformsToDownload = Object.keys(taskRefs.options.download),
      numToDownload = platformsToDownload.length,
      timeoutId;

  function completed() {
    if (--numToDownload === 0) {
      clearTimeout(timeoutId);
      callback();
    }
  }

  function ready(platform, status, url) {
    platformsToDownload.splice(platformsToDownload.indexOf(platform), 1);
    if (status === 'complete') {
      taskRefs.needle.get(url, null,
          responseHandler("Getting download location for " + platform, taskRefs, function (response, data) {
            taskRefs.log.ok("Downloading " + platform + " app");
            needle.get(data.location, null,
                function (err, response, data) {
                  taskRefs.log.ok("Downloaded " + platform + " app");
                  require('fs').writeFile(taskRefs.options.download[platform], data, completed);
                }
            );
          }, completed)
      );
    } else {
      taskRefs.log.error('Build failed for ' + platform + ': ' + status);
      completed();
    }
  }

  function check() {
    taskRefs.needle.get('/api/v1/apps/' + taskRefs.options.appId, null,
        responseHandler("Checking build status", taskRefs, function (response, data) {
          platformsToDownload.forEach(function (platform) {
            if (data.status[platform] !== 'pending') {
              ready(platform, data.status[platform], data.download[platform]);
            }
          });

          timeoutId = setTimeout(check, taskRefs.options.pollRate);
        })
    );
  }

  timeoutId = setTimeout(check, taskRefs.options.pollRate);
}

module.exports = function (options) {
    var zip = archiver('zip');
    var firstFile = null;
    var opts = _.extend({}, {
      timeout: 60000,
      pollRate: 15000
    }, options);

    return through.obj(function (file, enc, cb) {

        if (file.isNull()) {
            cb();
            return;
        } // ignore

        if (!firstFile) {
            firstFile = file;
        }

        zip.append(file.contents, { name: file.relative });
        cb();
    }, function (cb) {
      var   done = function () { self.emit('pg-sent'); taskRefs.log.ok('Application sent'); cb(); },
            self = this,
            taskRefs = {
                log: {
                    ok: function (msg) {
                        self.emit('pg-info', msg);
                        gutil.log('phonegap-build - info', gutil.colors.cyan(msg));
                    },
                    fail: function (msg) {
                        self.emit('pg-fail', msg);
                        gutil.log('phonegap-build - fail', gutil.colors.magenta(msg))
                    },
                    error: function (msg) {
                        self.emit('pg-error', msg);
                        gutil.log('phonegap-build - error', gutil.colors.magenta(msg))
                    },
                    warn: function (msg) {
                        self.emit('pg-warn', msg);
                        gutil.log('phonegap-build - warn', gutil.colors.magenta(msg))
                    }
                }, options: opts, done: done,
                needle: null // wrapped version added in start
            };

        zip.on('error', function (err) {
            taskRefs.log.error(err);
        });

        zip.finalize();
        zip.pipe(source('app.zip'))
            .pipe(buffer())
            .pipe(through.obj(function (file, err, cb) {
                taskRefs.archive = file.contents;

                cb();
        }, function () {
            if (!opts.user.password && !opts.user.token) {
                read({ prompt: 'Password: ', silent: true }, function (er, password) {
                    opts.user.password = password;
                    start(taskRefs);
                });
            } else {
                start(taskRefs);
            }
        }));
    });
};
