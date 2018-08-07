'use strict';

const config = require('config').config;
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const exec = require('child_process').exec;
const shellescape = require('shell-escape');
const filetype = require('file-type');
const {CronJob} = require('cron');
const gm = require('gm').subClass({imageMagick:true});
const ffmpeg = require('fluent-ffmpeg');
const express = require('express');
const upload = require('multer')({dest:path.join(__dirname, 'tmp')});

const app = express();
app.listen(config.server.port);
config.package = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
);
const message = {request:{}, response:{}};
console.info('%j', {
  message:'starting...',
  package:{name:config.package.name, version:config.package.version},
  server:{port:config.server.port},
});

const createFileName = (f, params) => {
  const values = [];
  Object.keys(params).forEach(k => {
    values.push(k);
    values.push(params[k]);
  });
  const sha1 = crypto.createHash('sha1');
  values.push(fs.readFileSync(f));
  sha1.update(values.join('::'));
  return sha1.digest('hex') + '.png';
};

const sendImage = (response, f, params) => {
  if (isExist(f)) {
    fs.readFile(f, (error, contents) => {
      if (error) {
        throw new Error(error);
      } else {
        console.info('%j', message);
        response.header('Content-Type', 'image/png');
        response.end(contents);
      }
    })
  } else {
    throw new Error(f + ' not found.');
  }
};

const getType = f => {
  return filetype(fs.readFileSync(f)).mime;
};

const isExist = f => {
  try {
    fs.statSync(f);
    return true
  } catch (error) {
    return false
  }
};

const isPDF = f => {
  return getType(f) == 'application/pdf';
};

const isVideo = f => {
  return config.video.types.indexOf(getType(f)) != -1;
};

const isOfficeDocument = f => {
  return config.office.types.indexOf(getType(f)) != -1;
};

const convertPDF = f => {
  return new Promise((resolve, reject) => {
    const dest = path.join(__dirname, 'tmp', path.basename(f, '.png') + '.png');
    gm(f).write(dest, error => {
      [
        dest,
        path.join(path.dirname(dest), path.basename(dest, '.png') + '-0.png'),
      ].forEach(name => {
        if (isExist(name)) {
          resolve(name);
        }
      })
    });
  });
};

const convertVideo = f => {
  return new Promise((resolve, reject) => {
    const dest = path.join(__dirname, 'tmp', path.basename(f) + '.png');
    ffmpeg(f).screenshots({
      timemarks: [0],
      folder:path.dirname(dest),
      filename:path.basename(dest),
    }).on('end', () => {
      resolve(dest);
    });
  });
};

const convertOfficeDocument = f => {
  return new Promise((resolve, reject) => {
    const dest = path.join(__dirname, 'tmp', path.basename(f) + '.png');
    const command = [
      'libreoffice',
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--convert-to', 'png',
      '--outdir', shellescape([path.dirname(dest)]),
      shellescape([f]),
    ].join(' ');
    exec(command, (error, stdout, stderr) => {
      resolve(dest);
    });
  });
};

app.get('/about', (request, response, next) => {
  message.request = {path:request.path};
  message.response = {};
  delete message.error;
  console.info('%j', message);
  response.json({
    package:config.package,
    config:config.server,
    purge:config.purge,
  });
});

app.post('/convert', upload.single('file'), (request, response, next) => {
  const params = Object.assign({}, request.body);
  params.function = 'convert';
  message.request = {path:request.path};
  delete message.error;

  if (isPDF(request.file.path)) {
    convertPDF(request.file.path).then(dest => {
      sendImage(response, dest, params);
    });
  } else if (isVideo(request.file.path)) {
    convertVideo(request.file.path).then(dest => {
      sendImage(response, dest, params);
    });
  } else if (isOfficeDocument(request.file.path)) {
    convertOfficeDocument(request.file.path).then(dest => {
      sendImage(response, dest, params);
    });
  } else {
    response.status(400);
    message.error = 'invalid file';
    console.error('%j', message);
    response.json(message);
  }
});

app.post('/resize', upload.single('file'), (request, response, next) => {
  const params = Object.assign({}, request.body);
  params.function = 'resize';
  params.width = (params.width || 100);
  params.height = (params.height || 100);
  params.background_color = (params.background_color || 'white');
  message.request = {params:params, path:request.path};
  const dest = path.join(__dirname, 'tmp', createFileName(request.file.path, params));
  message.response = {sent:dest};
  delete message.error;

  gm(request.file.path)
    .resize(params.width, params.height)
    .gravity('Center')
    .background(params.background_color)
    .extent(params.width, params.height)
    .write(dest, error => {
      if (error) {
        response.status(400);
        message.error = error;
        console.error('%j', message);
        response.json(message);
      } else {
        sendImage(response, dest, params);
      }
    });
});

app.post('/resize_width', upload.single('file'), (request, response, next) => {
  const params = Object.assign({}, request.body);
  params.function = 'resize_width';
  params.width = (params.width || 100);
  params.method = (params.method || 'resize');
  message.request = {params:params, path:request.path};
  const dest = path.join(__dirname, 'tmp', createFileName(request.file.path, params));
  message.response = {sent:dest};
  delete message.error;

  gm(request.file.path)[params.method](params.width, null).write(dest, error => {
    if (error) {
      response.status(400);
      message.error = error;
      console.error('%j', message);
      response.json(message);
    } else {
      sendImage(response, dest, params);
    }
  });
});

app.use((request, response, next) => {
  message.request = {params:request.query, path:request.path};
  message.response = {};
  message.error = 'Not Found';
  console.error('%j', message);
  response.status(404);
  response.json(message);
});

app.use((error, request, response, next) => {
  message.request = {params:request.query, path:request.path};
  message.response = {};
  message.error = error;
  console.error('%j', message);
  response.status(500);
  response.json(message);
});

new CronJob(config.purge.cron, () => {
  const dir = path.join(__dirname, 'tmp');
  fs.readdir(dir, (error, files) => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - config.purge.days);

    files.filter(f => {
      const stat = fs.statSync(path.join(__dirname, 'tmp', f));
      return stat.isFile() && !f.match(/^\./) && (stat.mtime < yesterday);
    }).forEach(f => {
      fs.unlink(path.join(dir, f), error => {
        if (error) {
          console.error('%j', {path:path.join(dir, f), message:error});
        } else {
          console.info('%j', {path:path.join(dir, f), message:'deleted'});
        }
      });
    });
  });
}, null, true);
