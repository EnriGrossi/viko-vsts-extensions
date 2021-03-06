// parse command line options
var minimist = require('minimist');
var mopts = {
    string: [
        'server',
        'suite',
        'task',
        'version'
    ]
};
var options = minimist(process.argv, mopts);

// remove well-known parameters from argv before loading make,
// otherwise each arg will be interpreted as a make target
process.argv = options._;

// modules
var make = require('shelljs/make');
var shell = require('shelljs');
var fs = require('fs');
var os = require('os');
var path = require('path');
var semver = require('semver');
var util = require('./make-util');
var uuid = require('node-uuid');

// util functions
var cd = util.cd;
var cp = util.cp;
var mkdir = util.mkdir;
var rm = util.rm;
var test = util.test;
var run = util.run;
var banner = util.banner;
var rp = util.rp;
var fail = util.fail;
var ensureExists = util.ensureExists;
var pathExists = util.pathExists;
var buildNodeTask = util.buildNodeTask;
var buildPs3Task = util.buildPs3Task;
var addPath = util.addPath;
var copyTaskResources = util.copyTaskResources;
var matchFind = util.matchFind;
var matchCopy = util.matchCopy;
var matchRemove = util.matchRemove;
var ensureTool = util.ensureTool;
var assert = util.assert;
var getExternals = util.getExternals;
var createResjson = util.createResjson;
var createTaskLocJson = util.createTaskLocJson;
var validateTask = util.validateTask;

// global paths
var buildPath = path.join(__dirname, '_build', 'Tasks');
var buildTestsPath = path.join(__dirname, '_build', 'Tests');
var commonPath = path.join(__dirname, '_build', 'Tasks', 'Common');
var packagePath = path.join(__dirname, '_package');
var testTasksPath = path.join(__dirname, '_test', 'Tasks');
var testPath = path.join(__dirname, '_test', 'Tests');

// node min version
var minNodeVer = '4.0.0';
if (semver.lt(process.versions.node, minNodeVer)) {
    fail('requires node >= ' + minNodeVer + '.  installed: ' + process.versions.node);
}

// add node modules .bin to the path so we can dictate version of tsc etc...
var binPath = path.join(__dirname, 'node_modules', '.bin');
if (!test('-d', binPath)) {
    fail('node modules bin not found.  ensure npm install has been run.');
}
addPath(binPath);

// resolve list of tasks
var taskList;
if (options.task) {
    // find using --task parameter
    taskList = matchFind(options.task, path.join(__dirname, 'Tasks'), { noRecurse: true })
        .map(function (item) {
            return path.basename(item);
        });
    if (!taskList.length) {
        fail('Unable to find any tasks matching pattern ' + options.task);
    }
}
else {
    // load the default list
    taskList = JSON.parse(fs.readFileSync(path.join(__dirname, 'make-options.json'))).tasks;
}

target.clean = function () {
    rm('-Rf', path.join(__dirname, '_build'));
    mkdir('-p', buildPath);
    rm('-Rf', path.join(__dirname, '_test'));
    rm('-Rf', packagePath);
    rm('-Rf', path.join(__dirname, '_temp'));
    //tasks clean up
    taskList.forEach(function(taskName) {
        banner('Cleaning: ' + taskName);
        var taskPath = path.join(__dirname, 'Tasks', taskName);
        rm('-Rf', path.join(taskPath, 'node_modules'));
        rm('-Rf', path.join(taskPath, 'typings'));
        banner(taskName+' was cleaned');
    });
};

//
// ex: node make.js build
// ex: node make.js build --task ShellScript
//
target.build = function() {
    //target.clean();
    ensureTool('tsc', '--version', 'Version 1.8.7');
    ensureTool('npm', '--version', function (output) {
        if (semver.lt(output, '3.0.0')) {
            fail('expected 3.0.0 or higher');
        }
    });
    taskList.forEach(function(taskName) {
        banner('Building: ' + taskName);
        var taskPath = path.join(__dirname, 'Tasks', taskName);
        ensureExists(taskPath);
        //copy tsconfig from __dirname to the task folder
        cp('-f',path.join(__dirname,'tsconfig.json'),taskPath);
        // load the task.json
        var outDir;
        var shouldBuildNode = true; //test('-f', path.join(taskPath, 'tsconfig.json'));
        var shouldBuildPs3 = false;
        var taskJsonPath = path.join(taskPath, 'task.json');
        if (test('-f', taskJsonPath)) {
            var taskDef = require(taskJsonPath);
            validateTask(taskDef);

            // fixup the outDir (required for relative pathing in legacy L0 tests)
            outDir = path.join(buildPath, taskDef.name);

            // create loc files
            createTaskLocJson(taskPath);
            createResjson(taskDef, taskPath);

            // determine the type of task
            shouldBuildNode = shouldBuildNode || taskDef.execution.hasOwnProperty('Node');
            shouldBuildPs3 = taskDef.execution.hasOwnProperty('PowerShell3');
        }
        else {
            outDir = path.join(buildPath, path.basename(taskPath));
        }

        mkdir('-p', outDir);

        // get externals
        var taskMakePath = path.join(taskPath, 'make.json');
        var taskMake = test('-f', taskMakePath) ? require(taskMakePath) : {};
        if (taskMake.hasOwnProperty('externals')) {
            console.log('Getting task externals');
            getExternals(taskMake.externals, outDir);
        }

        //--------------------------------
        // Common: build, copy, install 
        //--------------------------------
        if (taskMake.hasOwnProperty('common')) {
            var common = taskMake['common'];

            common.forEach(function(mod) {
                var modPath = path.join(taskPath, mod['module']);
                var modName = path.basename(modPath);
                var modOutDir = path.join(commonPath, modName);

                if (!test('-d', modOutDir)) {
                    banner('Building module ' + modPath, true);

                    mkdir('-p', modOutDir);

                    // create loc files
                    var modJsonPath = path.join(modPath, 'module.json');
                    if (test('-f', modJsonPath)) {
                        createResjson(require(modJsonPath), modPath);
                    }

                    // npm install and compile
                    if ((mod.type === 'node' && mod.compile == true) || test('-f', path.join(modPath, 'tsconfig.json'))) {
                        //copy tsconfig from __dirname to the task folder
                        cp('-f',path.join(__dirname,'tsconfig.json'),modPath);
                        buildNodeTask(modPath, modOutDir,true);
                        rm('-f',path.join(modPath,'tsconfig.json'));
                    }

                    // copy default resources and any additional resources defined in the module's make.json
                    console.log();
                    console.log('> copying module resources');
                    var modMakePath = path.join(modPath, 'make.json');
                    var modMake = test('-f', modMakePath) ? require(modMakePath) : {};
                    copyTaskResources(modMake, modPath, modOutDir);

                    // get externals
                    if (modMake.hasOwnProperty('externals')) {
                        console.log('Getting module externals');
                        getExternals(modMake.externals, modOutDir);
                    }
                }

                // npm install the common module to the task dir
                if (mod.type === 'node' && mod.compile == true) {
                    mkdir('-p', path.join(taskPath, 'node_modules'));
                    rm('-Rf', path.join(taskPath, 'node_modules', modName));
                    var originalDir = pwd();
                    cd(taskPath);
                    run('npm install ' + modOutDir);
                    cd(originalDir);
                }
                // copy module resources to the task output dir
                else if (mod.type === 'ps') {
                    console.log();
                    console.log('> copying module resources to task');
                    var dest;
                    if (mod.hasOwnProperty('dest')) {
                        dest = path.join(outDir, mod.dest, modName);
                    }
                    else {
                        dest = path.join(outDir, 'ps_modules', modName);
                    }

                    matchCopy('!Tests', modOutDir, dest, { noRecurse: true });
                }
            });
        }

        // build Node task
        if (shouldBuildNode) {
            if(options.skipNpm) {
                //copy project wide node_modules to the task folder
                console.log(path.join(__dirname,'node_modules'));
                if(test('-d',path.join(__dirname,'node_modules'))) {
                    console.log("copying node_modules")
                    cp('-r',path.join(__dirname,'node_modules'),taskPath);
                } 
                else {

                    options.skipNpm=false;
                }
            }
            
            buildNodeTask(taskPath, outDir,options.skipNpm);
        }

        // build PowerShell3 task
        if (shouldBuildPs3) {
            buildPs3Task(taskPath, outDir);
        }

        // copy default resources and any additional resources defined in the task's make.json
        console.log();
        console.log('> copying task resources');
        copyTaskResources(taskMake, taskPath, outDir);
        //tsconfig cleanup
        rm('-f',path.join(taskPath,'tsconfig.json'))
    });
    banner('Build successful', true);
}

//
// will run tests for the scope of tasks being built
// npm test
// node make.js test
// node make.js test --task ShellScript --suite L0
//
target.test = function() {
    ensureTool('tsc', '--version', 'Version 1.8.7');
    ensureTool('mocha', '--version', '2.3.3');

    // build/copy the ps test infra
    rm('-Rf', buildTestsPath);
    mkdir('-p', path.join(buildTestsPath, 'lib'));
    var runnerSource = path.join(__dirname, 'Tests', 'lib', 'psRunner.ts');
    run(`tsc ${runnerSource} --outDir ${path.join(buildTestsPath, 'lib')}`);
    console.log();
    console.log('> copying ps test lib resources');
    matchCopy('+(*.ps1|*.psm1)', path.join(__dirname, 'Tests', 'lib'), path.join(buildTestsPath, 'lib'));

    // run the tests
    var suiteType = options.suite || 'L0';
    var taskType = options.task || '*';
    var pattern1 = buildPath + '/' + taskType + '/Tests/' + suiteType + '.js';
    var pattern2 = buildPath + '/Common/' + taskType + '/Tests/' + suiteType + '.js';
    var testsSpec = matchFind(pattern1, buildPath)
        .concat(matchFind(pattern2, buildPath));
    if (!testsSpec.length) {
        fail(`Unable to find tests using the following patterns: ${JSON.stringify([pattern1, pattern2])}`);
    }

    run('mocha ' + testsSpec.join(' '), /*echo:*/true);
}

//
// node make.js testLegacy
// node make.js testLegacy --suite L0/XCode
//

target.testLegacy = function() {
    ensureTool('tsc', '--version', 'Version 1.8.7');
    ensureTool('mocha', '--version', '2.3.3');

    // clean
    console.log('removing _test');
    rm('-Rf', path.join(__dirname, '_test'));

    // copy the tasks to the test dir
    console.log();
    console.log('> copying tasks');
    mkdir('-p', testTasksPath);
    cp('-R', path.join(buildPath, '*'), testTasksPath);

    // compile L0 and lib
    var testSource = path.join(__dirname, 'Tests');
    cd(testSource);
    run('tsc --outDir ' + testPath + ' --rootDir ' + testSource);

    // copy L0 test resources
    console.log();
    console.log('> copying L0 resources');
    matchCopy('+(data|*.ps1|*.json)', path.join(__dirname, 'Tests', 'L0'), path.join(testPath, 'L0'), { dot: true });

    // copy test lib resources (contains ps scripts, etc)
    console.log();
    console.log('> copying lib resources');
    matchCopy('+(*.ps1|*.psm1|package.json)', path.join(__dirname, 'Tests', 'lib'), path.join(testPath, 'lib'));

    // create a test temp dir - used by the task runner to copy each task to an isolated dir
    var tempDir = path.join(testPath, 'Temp');
    process.env['TASK_TEST_TEMP'] = tempDir;
    mkdir('-p', tempDir);

    // suite path
    var suitePath = path.join(testPath, options.suite || 'L0/**', '_suite.js');
    suitePath = path.normalize(suitePath);
    var testsSpec = matchFind(suitePath, path.join(testPath, 'L0'));
    if (!testsSpec.length) {
        fail(`Unable to find tests using the following pattern: ${suitePath}`);
    }

    // mocha doesn't always return a non-zero exit code on test failure. when only
    // a single suite fails during a run that contains multiple suites, mocha does
    // not appear to always return non-zero. as a workaround, the following code
    // creates a wrapper suite with an "after" hook. in the after hook, the state
    // of the runnable context is analyzed to determine whether any tests failed.
    // if any tests failed, log a ##vso command to fail the build.
    var testsSpecPath = ''
    var testsSpecPath = path.join(testPath, 'testsSpec.js');
    var contents = 'var __suite_to_run;' + os.EOL;
    contents += 'describe(\'Legacy L0\', function (__outer_done) {' + os.EOL;
    contents += '    after(function (done) {' + os.EOL;
    contents += '        var failedCount = 0;' + os.EOL;
    contents += '        var suites = [ this._runnable.parent ];' + os.EOL;
    contents += '        while (suites.length) {' + os.EOL;
    contents += '            var s = suites.pop();' + os.EOL;
    contents += '            suites = suites.concat(s.suites); // push nested suites' + os.EOL;
    contents += '            failedCount += s.tests.filter(function (test) { return test.state != "passed" }).length;' + os.EOL;
    contents += '        }' + os.EOL;
    contents += '' + os.EOL;
    contents += '        if (failedCount && process.env.TF_BUILD) {' + os.EOL;
    contents += '            console.log("##vso[task.logissue type=error]" + failedCount + " test(s) failed");' + os.EOL;
    contents += '            console.log("##vso[task.complete result=Failed]" + failedCount + " test(s) failed");' + os.EOL;
    contents += '        }' + os.EOL;
    contents += '' + os.EOL;
    contents += '        done();' + os.EOL;
    contents += '    });' + os.EOL;
    testsSpec.forEach(function (itemPath) {
        contents += `    __suite_to_run = require(${JSON.stringify(itemPath)});` + os.EOL;
    });
    contents += '});' + os.EOL;
    fs.writeFileSync(testsSpecPath, contents);
    run('mocha ' + testsSpecPath, /*echo:*/true);
}

target.package = function() {
    // clean
    rm('-Rf', packagePath);

    console.log('> Staging content for individual task zips');
    var individualZipStagingPath = path.join(packagePath, 'individual-zip-staging');
    util.stageTaskZipContent(buildPath, individualZipStagingPath, /*metadataOnly*/false);

    console.log();
    console.log('> Staging metadata for wrapper zip');
    var wrapperZipStagingPath = path.join(packagePath, 'wrapper-zip-staging');
    util.stageTaskZipContent(buildPath, wrapperZipStagingPath, /*metadataOnly*/true);

    // mark the layout with a version number. servicing needs to support both this new format
    // and the original layout format as well.
    fs.writeFileSync(path.join(wrapperZipStagingPath, 'layout-version.txt'), '2');

    // create the tasks zip
    var zipPath = path.join(packagePath, 'pack-source', 'contents', 'Microsoft.TeamFoundation.Build.Tasks.zip');
    ensureTool('powershell.exe',
        '-NoLogo -Sta -NoProfile -NonInteractive -ExecutionPolicy Unrestricted -Command "$PSVersionTable.PSVersion.Major"',
        function (output) {
            if (!Number.parseInt(output) >= 5) {
                fail('expected version 5 or higher');
            }
        });
    run(`powershell.exe -NoLogo -Sta -NoProfile -NonInteractive -ExecutionPolicy Unrestricted -Command "& '${path.join(__dirname, 'Compress-Tasks.ps1')}' -IndividualZipStagingPath '${individualZipStagingPath}' -WrapperZipStagingPath '${wrapperZipStagingPath}' -ZipPath '${zipPath}'"`, /*echo:*/true);

    // nuspec
    var version = options.version;
    if (!version) {
        fail('supply version with --version');
    }

    if (!semver.valid(version)) {
        fail('invalid semver version: ' + version);
    }

    var pkgName = 'OpenBank.Build.Tasks';
    console.log();
    console.log('> Generating .nuspec file');
    var contents = '<?xml version="1.0" encoding="utf-8"?>' + os.EOL;
    contents += '<package xmlns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd">' + os.EOL;
    contents += '   <metadata>' + os.EOL;
    contents += '      <id>' + pkgName + '</id>' + os.EOL;
    contents += '      <version>' + version + '</version>' + os.EOL;
    contents += '      <authors>bigbldt</authors>' + os.EOL;
    contents += '      <owners>bigbldt,Microsoft</owners>' + os.EOL;
    contents += '      <requireLicenseAcceptance>false</requireLicenseAcceptance>' + os.EOL;
    contents += '      <description>For VSS internal use only</description>' + os.EOL;
    contents += '      <tags>VSSInternal</tags>' + os.EOL;
    contents += '   </metadata>' + os.EOL;
    contents += '</package>' + os.EOL;
    var nuspecPath = path.join(packagePath, 'pack-source', pkgName + '.nuspec');
    fs.writeFileSync(nuspecPath, contents);

    // package
    ensureTool('nuget.exe');
    var nupkgPath = path.join(packagePath, 'pack-target', `${pkgName}.${version}.nupkg`);
    mkdir('-p', path.dirname(nupkgPath));
    run(`nuget.exe pack ${nuspecPath} -OutputDirectory ${path.dirname(nupkgPath)}`);
}

// used by CI that does official publish
target.publish = function() {
    var server = options.server;
    assert(server, 'server');

    // resolve the nupkg path
    var nupkgFile;
    var nupkgDir = path.join(packagePath, 'pack-target');
    if (!test('-d', nupkgDir)) {
        fail('nupkg directory does not exist');
    }

    var fileNames = fs.readdirSync(nupkgDir);
    if (fileNames.length != 1) {
        fail('Expected exactly one file under ' + nupkgDir);
    }

    nupkgFile = path.join(nupkgDir, fileNames[0]);

    // publish the package
    ensureTool('nuget3.exe');
    run(`nuget3.exe push ${nupkgFile} -Source ${server} -apikey Skyrise`);
}

// used to bump the patch version in task.json files
target.bump = function() {
    taskList.forEach(function (taskName) {
        var taskJsonPath = path.join(__dirname, 'Tasks', taskName, 'task.json');
        var taskJson = JSON.parse(fs.readFileSync(taskJsonPath));
        if (typeof taskJson.version.Patch != 'number') {
            fail(`Error processing '${taskName}'. version.Patch should be a number.`);
        }

        taskJson.version.Patch = taskJson.version.Patch + 1;
        fs.writeFileSync(taskJsonPath, JSON.stringify(taskJson, null, 4));
    });
}

function manifestContibution(id,name,friendlyName) {
    return {
        "id": id,
        "type": "ms.vss-distributed-task.task",
        "targets": [
            "ms.vss-distributed-task.tasks"
        ],
        "properties": {
            "name": name,
            "friendlyName" : friendlyName
        }
    }
}

function makeCompositeExtension() {
    var destFolder = buildPath;
    //copy assets to the build folder
    cp('-R',path.join(__dirname, 'assets'),destFolder);
    //copy  extension .md
    cp('-f',path.join(__dirname,'*.md'),destFolder);
    cp('-f',path.join(destFolder,'ParallelBuilds.md'),path.join(destFolder,'overview.md'));
    //generate manifest
    var manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets','vss-extension.json')));
    manifest.contributions=[];
    manifest.files=[{path: "overview.md"}];
    taskList.forEach(function(taskName) {
        var taskPath = path.join(__dirname, 'Tasks', taskName);
        var taskJsonPath = path.join(taskPath, 'task.json');
        var taskPackageJsonPath = path.join(taskPath, 'package.json');
        if (test('-f', taskJsonPath)) {
            var taskDef = require(taskJsonPath);
            var taskPkg = JSON.parse(fs.readFileSync(taskPackageJsonPath));
            console.log('Creating manifest for task: '+taskDef.name);            
            manifest.files.push({path: taskDef.name});
            manifest.contributions.push(manifestContibution(taskPkg.name,taskDef.name,taskDef.friendlyName));
        }
    });
    let manifestContent = JSON.stringify(manifest,null,4);
    fs.writeFileSync(path.join(buildPath,'vss-extension.json'),manifestContent);
    var curdir = __dirname;
    cd(buildPath);
    run('tfx extension create --manifest-globs vss-extension.json');
    cd(curdir);
}

//create manifest file 
target.makeExtensions = function() {
    ensureTool('tfx');
    if(options.all) return makeCompositeExtension();
    
    var extList = taskList;
    if(options.exts) {
        extList = options.exts.split(',');
    }
    
    extList.forEach(function(taskName) {
        var taskPath = path.join(__dirname, 'Tasks', taskName);
        var defaultImage = path.join(__dirname,'assets','extension-icon.png');
        var manifestTemplateFile = path.join(__dirname,'assets','vss-extension-template.json');
        ensureExists(taskPath);
        // load the task.json
        var outDir;
        var taskJsonPath = path.join(taskPath, 'task.json');
        var taskPackageJsonPath = path.join(taskPath, 'package.json');
        if (test('-f', taskJsonPath)) {
            var taskDef = require(taskJsonPath);
            var manifest = JSON.parse(fs.readFileSync(manifestTemplateFile));
            var taskPkg = JSON.parse(fs.readFileSync(taskPackageJsonPath));
            console.log('Creating manifest for task: '+taskDef.name);            
            manifest.version=`${taskDef.version.Major}.${taskDef.version.Minor}.${taskDef.version.Patch}`;
            manifest.id=manifest.id+'-'+taskDef.name;
            manifest.name=manifest.name+' '+taskDef.friendlyName;
            manifest.files[0].path=taskDef.name;
            manifest.contributions[0].id=taskPkg.name;
            manifest.contributions[0].properties.name=taskDef.name;
            manifest.contributions[0].properties.friendlyName=taskDef.friendlyName;
            var iconPath=path.join(buildPath,taskName,'extension-icon.png');
            if(!test('-f',iconPath)) {
                manifest.icons.default='extension-icon.png';
                iconPath=defaultImage;
            }
            console.log(iconPath);
            console.log(buildPath);
            cp('-f',iconPath,buildPath);
            manifestContent = JSON.stringify(manifest,null,4); 
            //console.log(manifestContent);
            fs.writeFileSync(path.join(buildPath,'vss-extension.json'),manifestContent);
            var curdir = __dirname;
            cd(buildPath);
            run('tfx extension create --manifest-globs vss-extension.json');
            cd(curdir);
        } 
    })
}

target.generate = function() {
    var taskName = options.name;
    var taskLocation = path.join(__dirname, 'Tasks', taskName);
    var taskcodegen = path.join(__dirname,"codegen","task");
    var taskFileName = taskName.toLowerCase()+".ts";
    //create folder and copy files
    mkdir('-p', taskLocation);
    cp("-f", path.join(taskcodegen,"*.*"),taskLocation);
    shell.mv(path.join(taskLocation,"task.ts"),path.join(taskLocation,taskFileName))
    //generate guid
    var taskId = uuid.v4();
    //modify files
    //package.json
    var makeOptionsPath = path.join(__dirname,"make-options.json")
    var makeOptions = JSON.parse(fs.readFileSync(makeOptionsPath));
    var packagePath = path.join(taskLocation,"package.json");
    var taskPkg = JSON.parse(fs.readFileSync(packagePath));
    taskPkg.name = (makeOptions.packageName || "") + taskName.toLowerCase();
    taskPkg.main = taskFileName;
    taskPkg.author = makeOptions.authorName || taskPkg.author;
    taskPkg.license = makeOptions.license || taskPkg.license;
    fs.writeFileSync(packagePath,JSON.stringify(taskPkg,null,4));
    //task.json
    var taskDefPath = path.join(taskLocation,"task.json");
    var taskDef = JSON.parse(fs.readFileSync(taskDefPath));
    taskDef.id = taskId;
    taskDef.friendlyName = taskDef.description = taskDef.name= taskName;
    taskDef.author =  makeOptions.authorName || taskDef.author;
    taskDef.instanceNameFormat = `${taskName} $(testparam)`;
    taskDef.execution.Node.target = taskFileName;
    fs.writeFileSync(taskDefPath,JSON.stringify(taskDef,null,4));
    //modify makeOptions - add current task;
    makeOptions.tasks.push(taskName);
    fs.writeFileSync(makeOptionsPath,JSON.stringify(makeOptions,null,4));
    //done
    console.log(`${taskName} successfully created`);
}