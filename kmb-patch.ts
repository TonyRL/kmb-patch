const tempy = require('tempy');
const {execSync} = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ProgressBar = require('progress');
const extract = require("extract-zip");
const cheerio = require('cheerio');
const glob = require("glob");
const tar = require('tar-stream');

/**
 * KMB Patch Class
 */
export class KMBPatch {
    public inputAPK : string;
    public outputAPK : string;
    public tempDir : string;
    public forceOverwrite = true;
    public mapKey = "";

    public signKey = "tools/sign-key.jks";
    public keystorePassword = "";
    public keyAlias = "louislam";
    public keyPassword = "";

    public downloadJava = true;
    public java = '"tools/jdk-11.0.8+10-jre/bin/java"';


    constructor(inputAPK : string, outputAPK = "patched-kmb.apk", tempDir = "tmp") {
        this.mapKey = Buffer.from("QUl6YVN5QXR6Y2t0UzFfb1RBOHJ5dXBXdjFqcENCUXJZRjNHVVJr", 'base64').toString('utf8');
        this.keystorePassword = Buffer.from("Q25oUWJuZ3U4YUxGVlI2ckhHczZ6a29yeVpjSlZlREY=", 'base64').toString('utf8');
        this.keyPassword = this.keystorePassword;

        this.inputAPK = inputAPK;
        this.outputAPK = outputAPK;

        if (tempDir == null) {
            this.tempDir = tempy.directory();
            this.forceOverwrite = true;
        } else {
            this.tempDir = tempDir;
        }

        console.log("Temp Dir: " + this.tempDir);
        console.log("OS: " + os.platform());

        if (os.platform() !== "win32") {
            this.downloadJava = false;
            this.java = "java";
        }
    }

    /**
     * Patch the apk
     */
    async patch() {
        let exitCode = 0;
        let self = this;

        try {
            await this.downloadTools();

            if (fs.existsSync(this.tempDir)){
                fs.rmSync(this.tempDir, {
                    recursive: true
                });
            }

            let escapedTempDir = escapeShellArg(this.tempDir);
            let escapedInputAPK = escapeShellArg(this.inputAPK);
            let escapedOutputAPK;
            let f = "";

            let escapedSignKey = escapeShellArg(this.signKey);
            let escapedKeystonePassword = escapeShellArg(this.keystorePassword);
            let escapedKeyAlias = escapeShellArg(this.keyAlias);
            let escapedKeyPassword = escapeShellArg(this.keyPassword);

            if (this.forceOverwrite) {
                f = "-f";
            }

            console.log("Extracting APK");
            let output : string = execSync(`${this.java} -Xmx512m -jar tools/apktool_2.4.1.jar d -o ${escapedTempDir} ${f} ${escapedInputAPK}`).toString();
            console.log(output);

            // Patch AndroidManifest.xml
            console.log("Patch AndroidManifest.xml");
            let xmlPath = this.tempDir + "/AndroidManifest.xml";
            let androidManifestXML : string = fs.readFileSync(xmlPath);
            let $ = cheerio.load(androidManifestXML,  {
                xmlMode: true
            });

            let versionCode : number = parseInt($("manifest").attr("platformBuildVersionCode"), 10);
            let versionName : string = $("manifest").attr("platformBuildVersionName");
            if (versionCode == 30) {
                // platformBuildVersionCode from AndroidManifest.xml is fixed to 30 since 2.0.3(193)
                let apktoolYmlPath : string = this.tempDir + "/apktool.yml";
                let apktoolYml : string = fs.readFileSync(apktoolYmlPath).toString();
                let versionCodeMatch = apktoolYml.match(/versionCode: '(\d+)'/);
                if (versionCodeMatch) {
                    versionCode = parseInt(versionCodeMatch[1], 10);
                }
                let versionNameMatch = apktoolYml.match(/versionName: (.+)/);
                if (versionNameMatch) {
                    versionName = versionNameMatch[1];
                }
            }
            this.outputAPK = `${this.outputAPK.split(".apk")[0]}-${$("manifest").attr("platformBuildVersionName")}.apk`;
            escapedOutputAPK = escapeShellArg(this.outputAPK);

            // Update MAP Key
            $("application meta-data").each(function () {
                if ($(this).attr("android:name") == "com.google.android.maps.v2.API_KEY") {
                    $(this).attr("android:value", self.mapKey);
                }
            });

            // Remove Splash Screen
            console.log("Remove Splash Screen");
            $("activity").each(function () {
                if ($(this).attr("android:name") == "com.mobilesoft.mybus.KMBMainView") {
                    $(this).append(`
                        <intent-filter>
                            <action android:name="android.intent.action.MAIN"/>
                            <category android:name="android.intent.category.LAUNCHER"/>
                        </intent-filter>
                    `);
                } else if  ($(this).attr("android:name") == "com.mobilesoft.mybus.KMBSplashScreen") {
                    $(this).empty();
                }
            });

            fs.writeFileSync(xmlPath, $.xml());

            // Remove AdView in xml
            let resXMLPath = this.tempDir + '/res/**/*.xml';
            let fileList = glob.sync(resXMLPath);

            for (let i = 0; i < fileList.length; i++) {
                let filename = fileList[i];
                let text = fs.readFileSync(filename).toString();

                if (text.includes("com.google.android.gms.ads.AdView")) {
                    console.log("Remove AdView in " + filename);
                    $ = cheerio.load(text,  {
                        xmlMode: true
                    });
                    $("com\\.google\\.android\\.gms\\.ads\\.AdView").remove();
                    fs.writeFileSync(filename, $.xml());
                }
            }

            // smali_classes2 folder
            let path = this.tempDir + '/smali_classes2/**/*.smali';
            fileList = glob.sync(path);

            for (let i = 0; i < fileList.length; i++) {
                let updated = false;
                let filename = fileList[i];
                let text = fs.readFileSync(filename).toString();
                let lines = text.split(/\r?\n/);

                for (let j = 0; j < lines.length; j++) {
                    let line = lines[j];

                    // Disable check update
                    if (line.includes(", 0x2712")) {
                        console.log("Remove force update in " + filename);
                        lines[j] = line.replace(", 0x2712", ", 0x2760");
                        updated = true;
                    }

                    // Remove loadAd code
                    if (line.includes("->loadAd(")) {
                        console.log("Remove loadAd code in " + filename);
                        lines[j] = "#" + line;

                        // Also comment previous line if is .line
                        if (lines[j - 1].trim().startsWith(".line")) {
                            lines[j - 1] = "#" + lines[j - 1];
                        }

                        updated = true;
                    }

                    // Remove setVisibility code
                    if (line.includes("AdView;->setVisibility")) {
                        console.log("Remove setVisibility code in " + filename);
                        lines[j] = "#" + line;

                        // Also comment previous line if is .line
                        if (lines[j - 1].trim().startsWith(".line")) {
                            lines[j - 1] = "#" + lines[j - 1];
                        }

                        updated = true;
                    }

                    // Remove InterstitialAd
                    // Smali: InterstitialAd;->load ==== JAVA: InterstitialAd.load(...)
                    if (line.includes("InterstitialAd;->load")) {
                        console.log("Remove InterstitialAd code in " + filename);
                        lines[j] = "#" + line;

                        // Also comment previous line if is .line
                        if (lines[j - 1].trim().startsWith(".line")) {
                            lines[j - 1] = "#" + lines[j - 1];
                        }

                        updated = true;
                    }

                    // Remove Builtin Ads for 1.7.9(157)
                    if (versionCode <= 157 && line.includes("https://app.kmb.hk/app1933/index.php")) {
                        console.log("Remove Builtin Ads in " + filename);

                        // Keep finding `/mybus/manager/h` (JAVA: mybus.manager.h(...)), if found, add # at the beginning to comment it
                        let k = j;
                        let foundTheCall = false;

                        while (k >= 0 && k < lines.length) {
                            if (lines[k].includes("/mybus/manager/h")) {
                                lines[k] = "#" + lines[k];
                                foundTheCall = true;
                                break;
                            }
                            k++;
                        }

                        if (!foundTheCall) {
                            console.error("Failed to remove Builtin Ads in " + filename);
                        } else {
                            updated = true;
                        }
                    }

                }

                if (updated) {
                    fs.writeFileSync(filename, lines.join(os.EOL));
                }
            }

            // /smali/ folder
            path = this.tempDir + '/smali/**/*.smali';
            fileList = glob.sync(path);
            let builtinAdsClass : string;
            switch (true) {
                case versionCode >= 180: // 1.9.1(180) ~ 2.0.5(196)
                    builtinAdsClass = "m";
                    break;
                case versionCode <= 179: // 1.8.6(174) ~ 1.9.0(179)
                    builtinAdsClass = "l";
                    break;
                case versionCode == 173: // 1.8.5(173)
                    builtinAdsClass = "j";
                    break;
                case versionCode > 157 && versionCode <= 171: // 1.8.0(160) ~ 1.8.4(171)
                    builtinAdsClass = "i";
                    break;
                default:
                    builtinAdsClass = "m";
                    break;
            }

            for (let i = 0; i < fileList.length; i++) {
                let updated = false;
                let filename = fileList[i];
                let text = fs.readFileSync(filename).toString();
                let lines = text.split(/\r?\n/);

                for (let j = 0; j < lines.length; j++) {
                    let line = lines[j];

                    // Remove Builtin Ads
                    if (line.includes("https://app.kmb.hk/app1933/index.php")) {
                        console.log("Remove Builtin Ads in " + filename);

                        // Keep finding `/mybus/manager/m` (JAVA: mybus.manager.m(...)), if found, add # at the beginning to comment it
                        let k = j;
                        let foundTheCall = false;

                        while (k >= 0 && k < lines.length) {
                            if (lines[k].includes("/mybus/manager/" + builtinAdsClass)) {
                                lines[k] = "#" + lines[k];
                                foundTheCall = true;
                                break;
                            }
                            k++;
                        }

                        if (!foundTheCall) {
                            console.error("Failed to remove Builtin Ads in " + filename);
                        } else {
                            updated = true;
                        }
                    }
                }

                if (updated) {
                    fs.writeFileSync(filename, lines.join(os.EOL));
                }
            }

            console.log("Build APK");
            output = execSync(`${this.java} -Xmx512m -jar tools/apktool_2.4.1.jar b ${escapedTempDir} -o  ${escapedOutputAPK}`).toString();
            console.log(output);

            console.log("Sign the APK");
            output = execSync(`${this.java} -Xmx512m -jar tools/uber-apk-signer-1.1.0.jar -a ${escapedOutputAPK} --allowResign --overwrite --ks ${escapedSignKey} --ksPass ${escapedKeystonePassword} --ksAlias ${escapedKeyAlias} --ksKeyPass ${escapedKeyPassword}`).toString();
            console.log(output);

            console.log("Patched successfully! The patch apk file located in " + this.outputAPK);


        } catch (error) {
            console.error(error.message);
            exitCode = 1;
        }

        if (fs.existsSync(this.tempDir)){
            fs.rmSync(this.tempDir, {
                recursive: true
            });
        }

        return exitCode;
    }

    /**
     * Download all tools
     */
    async downloadTools() {
        console.log("Download Tools");

        if (! fs.existsSync("tools/apktool_2.4.1.jar")) {
            await this.downloadFile("https://github.com/iBotPeaches/Apktool/releases/download/v2.4.1/apktool_2.4.1.jar", "apktool_2.4.1.jar");
        }

        if (! fs.existsSync("tools/uber-apk-signer-1.1.0.jar")) {
            await this.downloadFile("https://github.com/patrickfav/uber-apk-signer/releases/download/v1.1.0/uber-apk-signer-1.1.0.jar", "uber-apk-signer-1.1.0.jar");
        }

        if (! fs.existsSync("tools/abe.jar")) {
            await this.downloadFile("https://github.com/nelenkov/android-backup-extractor/releases/download/20181012025725-d750899/abe-all.jar", "abe.jar")
        }

        // JRE Download link from https://adoptopenjdk.net/archive.html
        if (this.downloadJava && ! fs.existsSync("tools/jdk-11.0.8+10-jre")) {
            await this.downloadFile("https://github.com/AdoptOpenJDK/openjdk11-binaries/releases/download/jdk-11.0.8%2B10/OpenJDK11U-jre_x64_windows_hotspot_11.0.8_10.zip", "jre.zip");

            await extract("tools/jre.zip", {
                dir: path.resolve("tools")
            });
        }
        console.log("Downloaded all tools");
    }

    /**
     * Download a file
     * Copy from https://futurestud.io/tutorials/axios-download-progress-in-node-js
     */
    async downloadFile(url, filename) {
        console.log('Download ' + path.basename(url))
        const { data, headers } = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });
        const totalLength = parseInt(headers['content-length']);

        const progressBar = new ProgressBar('downloading [:bar] :percent :etas', {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 1,
            total: totalLength
        });

        const writer = fs.createWriteStream(path.resolve(__dirname, 'tools', filename));

        data.on('data', (chunk) => {
            progressBar.tick(chunk.length);
            data.finished
        });



        await new Promise<void>((resolve) => {
            writer.on("finish", () => {
                console.log("Downloaded and renamed to " + filename);
                resolve();
            });

            data.pipe(writer)
        });

    }

    /**
     * Restore and patch the appdata.ab
     */
    async restore() {
        try {
            if (! fs.existsSync("tmp")) {
                fs.mkdirSync("tmp");
            }

            if (! fs.existsSync("tmp/appdata")) {
                fs.mkdirSync("tmp/appdata");
            }

            if (! fs.existsSync("appdata.ab")) {
                throw "appdata.ab not found";
            }

            console.log("Patching backup")

            execSync(`${this.java} -jar tools/abe.jar unpack appdata.ab tmp/appdata.tar`);

            // Stream is fun
            // oldTarballStream -> extract (Stream) -> only replace "_manifest" -> pack (Stream) -> newTarballStream

            let oldTarballStream = fs.createReadStream("tmp/appdata.tar");
            let newTarballStream = fs.createWriteStream("tmp/patched-appdata.tar");

            var pack = tar.pack();
            var extract = tar.extract();

            extract.on('entry', function(header, stream, callback) {
                if (header.name == "apps/com.kmb.app1933/_manifest") {
                    let stat = fs.statSync("tools/_manifest");
                    let manifestStream = fs.createReadStream("tools/_manifest");
                    header.size = stat.size;
                    manifestStream.pipe(pack.entry(header, callback))
                } else {
                    stream.pipe(pack.entry(header, callback))
                }
            })

            extract.on('finish', function () {
                pack.finalize()
            })

            await new Promise<void>((resolve) => {
                newTarballStream.on("finish", function () {
                    newTarballStream.end();
                    resolve();
                });

                oldTarballStream.pipe(extract);
                pack.pipe(newTarballStream);
            });

            execSync(`${this.java} -jar tools/abe.jar pack tmp/patched-appdata.tar patched-appdata.ab`);

            console.log("Connect your phone to your PC and accept restore");
            execSync(`adb restore patched-appdata.ab`);

        } catch (error) {
            console.error(error.message);
            return 1;
        }

        return 0;
    }
}

function escapeShellArg(arg) {
    let quote;

    if (os.platform() == 'win32') {
        quote = '"';
    } else {
        quote = "'";
    }

    return quote + `${arg.replace(/'/g, `'\\''`)}` + quote;
}
