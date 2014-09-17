var commander = require('commander');
var Karotz = require('./lib/karotz');

commander.version(require("./package.json").version);
commander.option("-h, --host <host>", "Karotz host name or IP");
commander.option("--keepAlive <second>", "Karotz connexion keep alive");
commander.option("--lang <lang>", "Karotz lang (fr-FR, en-GB, en-US, de-De, es-ES)");
commander.option("--httpPort <port>", "Http port");
commander.option("--pingDelay <second>", "Karotz ping delay");

commander.parse(process.argv);

commander.host = commander.host || "192.168.3.230";

var karotz = new Karotz(commander);

karotz
		.open(function(error) {
			if (error) {
				console.error("Can not open karotz: ", error);
				return;
			}

			console.log("Karotz connected !");

			karotz.startTts("Test de karotz", function(error) {
				console.log("Envoyé et dicté !", error);
			});

			karotz
					.playSound(
							"C:\\Users\\oeuillot\\Music\\A State Of Trance 650 (Armin Van Buuren - Warm Up Sets)\\01. Lane 8 feat. Lucy Stone - Nothing You Can Say (Radio Edit).mp3",
							function(error) {

								console.log("Envoyé !", error);
							});
			/*
			 * karotz.startTts("Les devoirs sont finis", function(error) {
			 * console.log("Envoyé et dicté ! 2", error); });
			 */

			setTimeout(function() {
				karotz.stopSound(function(error) {
					console.log("Stopped !", error);
				});
			}, 15000);
		});