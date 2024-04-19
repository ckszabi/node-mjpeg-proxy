const MjpegProxy = require('./mjpeg-proxy').MjpegProxy;
const express = require('express');

app = express();

function ontimeout() {
    console.log("Timeout occured!");
}

app.use('/stream', MjpegProxy('http://172.24.90.11:8080/stream.mjpg', { timeout: 1000 }, ontimeout).proxyRequest);

app.listen(8080);