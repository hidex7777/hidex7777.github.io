// Pick one sketch at random on each load and start it as the page background.
(function () {
  var sketches = ['ink'];
  var name = sketches[Math.floor(Math.random() * sketches.length)];

  var script = document.createElement('script');
  script.src = 'sketches/' + name + '.js';
  script.onload = function () {
    new p5(window.SKETCHES[name], document.getElementById('canvas'));
  };
  document.body.appendChild(script);
})();
