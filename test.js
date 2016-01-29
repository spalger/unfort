require('source-map-support').install();

var fs = require('fs');
var profiler = require('v8-profiler');
const tracerPerf = require('./lib/tests/tracer-perf');

profiler.startProfiling('1', true);

tracerPerf.tracerPerf(false).then(function() {
  var profile1 = profiler.stopProfiling();

  profile1.export(function(error, result) {
    fs.writeFileSync(+new Date() + '.cpuprofile', result);
    profile1.delete();
  });
}).catch(function(err) {
  throw err;
});

