const chalk = require('chalk');
const fs = require('fs');
const Metalsmith = require('metalsmith');
const download = require('download-git-repo');
const inquirer = require('inquirer');
const ora = require('ora');
const { render } = require('consolidate').handlebars;
const path = require('path');
const logger = require('../logger');
const cosmiconfig = require('cosmiconfig');
const { getTemplateRecords, downloadRepo } = require('../utils');
const tmp = require('tmp');
const isGitUrl = require('is-git-url');

function getOptions(templateDirectory) {
  const moduleName = 'meta';
  const explorer = cosmiconfig('meta-config', {
    searchPlaces: [
      // 'package.json',
      `.${moduleName}rc`,
      `.${moduleName}.json`,
      `.${moduleName}.yaml`,
      `.${moduleName}.yml`,
      `.${moduleName}.js`,
      `${moduleName}.js`,
    ],
  });
  return explorer.searchSync(templateDirectory) || {};
}

function initProject(config) {
  const metaOpts = getOptions(config.templateDirectory);
  runMetalsmith(config, metaOpts.config || {});
}

function runMetalsmith(config, metaOpts) {
  const metalsmith = Metalsmith(path.join(config.templateDirectory, 'template'));
  const metaData = metalsmith.metadata();

  const questions = metaOpts && metaOpts.questions;
  //resolve the output destination path
  Object.assign(metaData, {
    destPath: config.destPath
      ? config.destPath
      : path.join(process.cwd(), config.answers.projectName || ''),
  });

  metalsmith
    .use(askQuestions(questions))
    .use(resolveMetaData(config))
    .use(renderTemplateFiles(config));

  metalsmith
    .clean(false)
    .source('.')
    .destination(metaData.destPath)
    .build((err, files) => {
      if (err) throw err;

      if (typeof metaOpts.endCallback === 'function') {
        const helpers = { chalk, logger, files };
        metaOpts.endCallback(metaData, helpers);
      } else {
        logger.success('init success');
      }
    });
}

function resolveMetaData(config) {
  return (files, metalsmith, done) => {
    var metaData = metalsmith.metadata();

    Object.assign(metaData.answers, config.answers);

    done();
  };
}

//Metalsmith plugin
function askQuestions(questions) {
  return (files, metalsmith, done) => {
    var metadata = metalsmith.metadata();

    if (!questions || !questions.length) {
      metadata.answers = {};
      return done();
    }

    inquirer.prompt(questions).then(answers => {
      metadata.answers = answers;
      done();
    });
  };
}

//Metalsmith plugin
function renderTemplateFiles() {
  return async (files, metalsmith, done) => {
    const keys = Object.keys(files);
    const metaData = metalsmith.metadata();

    for (const key of keys) {
      const str = files[key].contents.toString();
      //not find any template varible, just skip it
      if (!/{{([^{}]+)}}/g.test(str)) {
        continue;
      }

      try {
        const renderedContent = await render(str, metaData.answers);
        files[key].contents = Buffer.from(renderedContent);
      } catch (error) {
        error.message = `[${key}] ${error.message}`;
        throw error;
      }
    }

    done();
  };
}

async function loadRepository(templatePath) {
  const temporaryDir = tmp.dirSync().name;
  if (isGitUrl(templatePath)) {
    downloadRepo(templatePath, temporaryDir);
    return temporaryDir;
  }

  if (await fs.exists(templatePath)) {
    await fs.copy(templatePath, temporaryDir);
    return temporaryDir;
  }

  throw new Error(`Unknown template path: ${templatePath}`);
}

async function resolveOption(opts = {}) {
  const templateMap = getTemplateRecords();

  opts.answers = {};
  // check for templates
  if (!opts.templatePath) {
    const templateNames = Object.keys(templateMap);

    if (!templateNames.length) {
      logger.warn(`
       can not found any template
       try to add template by run
       $ inix add`);
      return;
    }

    opts.answers.template = (await inquirer.prompt([
      {
        type: 'list',
        name: 'template',
        message: 'Select template which you want',
        default: templateNames[0],
        choices: templateNames,
      },
    ])).template;
  }

  opts.answers.projectName = (await inquirer.prompt([
    {
      type: 'input',
      name: 'projectName',
      validate: function(val) {
        const reg = /[a-zA-Z0-9\-_]+/;
        if (!val) {
          return 'please input your project name';
        } else if (reg.test(val)) {
          return true;
        } else {
          return `input should be ${reg.toString}`;
        }
      },
    },
  ])).projectName;

  opts.templatePath =
    opts.templatePath || getTemplatePath(templateMap[answers.template]);

  return opts;
}

function getTemplatePath(templateInfo) {
  const templatePath = templateInfo.templatePath;
  if (isGitUrl(templatePath) && templateInfo.branch) {
    return templatePath + '#' + templateInfo.branch;
  }
  return templatePath;
}

function withLoading(fn, loadingMessage) {
  return async function(...args) {
    const spinner = ora(loadingMessage);
    try {
      spinner.start();

      const result = await fn(...args);

      spinner.stop();

      return result;
    } catch (error) {
      spinner.stop();
      throw error;
    }
  };
}

module.exports = async function(opts) {
  opts = await resolveOption(opts);

  if (!opts) return;

  const templateDirectory = await withLoading(loadRepository, 'Fetching template...')(opts.templatePath);
  Object.assign(opts, { templateDirectory });

  initProject(opts);
};
