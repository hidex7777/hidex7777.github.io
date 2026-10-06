// Pick one sketch at random on each load and start it as the page background.
// Each sketch is called with the p5 instance and the element it should draw into.
(function () {
  var sketches = ['ink'];
  var name = sketches[Math.floor(Math.random() * sketches.length)];
  var host = document.getElementById('canvas');

  var script = document.createElement('script');
  script.src = 'sketches/' + name + '.js';
  script.onload = function () {
    new p5(function (p) {
      window.SKETCHES[name](p, host);
    }, host);
  };
  document.body.appendChild(script);
})();
