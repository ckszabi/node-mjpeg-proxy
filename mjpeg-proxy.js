// Copyright (C) 2013, Georges-Etienne Legendre <legege@legege.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var url = require("url");
var http = require("http");

function extractBoundary(contentType) {
  contentType = contentType.replace(/\s+/g, "");

  var startIndex = contentType.indexOf("boundary=");
  var endIndex = contentType.indexOf(";", startIndex);
  if (endIndex == -1) {
    //boundary is the last option
    // some servers, like mjpeg-streamer puts a '\r' character at the end of each line.
    if ((endIndex = contentType.indexOf("\r", startIndex)) == -1) {
      endIndex = contentType.length;
    }
  }
  return contentType
    .substring(startIndex + 9, endIndex)
    .replace(/"/gi, "")
    .replace(/^\-\-/gi, "");
}

/**
 * MjpegProxy
 * @type {exports.MjpegProxy}
 * @param mjpegUrl {string|Object} - URL to MJPEG stream or URL object
 * @param mjpegUrl.host {string} - Hostname of MJPEG stream
 * @param mjpegUrl.port {number} - Port of MJPEG stream
 * @param mjpegUrl.path {string} - Path of MJPEG stream
 * @param mjpegUrl.auth {string} - Basic authentication string
 * @param mjpegUrl.method {string} - HTTP method eg GET
 *
 */
var MjpegProxy = (exports.MjpegProxy = function (mjpegUrl, options, ontimeout) {
  var self = this;

  if (!mjpegUrl) throw new Error('Please provide a source MJPEG URL config or config');

  if (typeof mjpegUrl === 'string') {
    mjpegUrl = new URL(mjpegUrl);
  }
  self.mjpegOptions = mjpegUrl;
  self.options = options || {};
  self.options = Object.assign(
    { timeout: 5000, destroyRequestOnIdle: true },
    self.options
  );

  self.audienceResponses = [];
  self.newAudienceResponses = [];

  self.boundary = null;
  self.globalMjpegResponse = null;
  self.mjpegRequest = null;

  self.proxyRequest = function (req, res) {
    if (res.socket == null) {
      return;
    }

    // There is already another client consuming the MJPEG response
    if (self.mjpegRequest !== null) {
      self._newClient(req, res);
    } else {
      // Send source MJPEG request
      self.mjpegRequest = http.request(
        self.mjpegOptions,
        function (mjpegResponse) {
          // console.log(`statusCode: ${mjpegResponse.statusCode}`)
          self.globalMjpegResponse = mjpegResponse;
          self.boundary = extractBoundary(
            mjpegResponse.headers["content-type"]
          );

          self._newClient(req, res);

          var lastByte1 = null;
          var lastByte2 = null;

          // Timeout handler
          self.to = setTimeout(function () {
            mjpegResponse.emit("timeout");

            // Abort current request and remove
            for (var i = self.audienceResponses.length; i--; ) {
              var res = self.audienceResponses[i];
              res.end();
            }
            
            if (self.mjpegRequest) {
              self.mjpegRequest.abort();
              self.mjpegRequest = null;
            }

            if (self.globalMjpegResponse) {
              self.globalMjpegResponse.destroy();
            }
          }, self.options.timeout);

          if (ontimeout) mjpegResponse.on("timeout", ontimeout);

          mjpegResponse.on("data", function (chunk) {
            // Fix CRLF issue on iOS 6+: boundary should be preceded by CRLF.
            clearTimeout(self.to);

            var buff = Buffer.from(chunk);
            if (lastByte1 != null && lastByte2 != null) {
              var oldheader = "--" + self.boundary;

              var p = buff.indexOf(oldheader);

              if (
                (p == 0 && !(lastByte2 == 0x0d && lastByte1 == 0x0a)) ||
                (p > 1 && !(chunk[p - 2] == 0x0d && chunk[p - 1] == 0x0a))
              ) {
                var b1 = chunk.slice(0, p);
                var b2 = Buffer.from("\r\n--" + self.boundary);
                var b3 = chunk.slice(p + oldheader.length);
                chunk = Buffer.concat([b1, b2, b3]);
              }
            }

            lastByte1 = chunk[chunk.length - 1];
            lastByte2 = chunk[chunk.length - 2];

            for (var i = self.audienceResponses.length; i--; ) {
              var res = self.audienceResponses[i];

              // First time we push data... lets start at a boundary
              if (self.newAudienceResponses.indexOf(res) >= 0) {
                var p = buff.indexOf("--" + self.boundary);
                if (p >= 0) {
                  res.write(chunk.slice(p));
                  self.newAudienceResponses.splice(
                    self.newAudienceResponses.indexOf(res),
                    1
                  ); // remove from new
                }
              } else {
                res.write(chunk);
              }
            }

            // Set next timeout on schedule
            self.to = setTimeout(function () {
              mjpegResponse.emit("timeout");
            }, self.options.timeout);
          });
          mjpegResponse.on("end", function () {
            clearTimeout(self.to);
            // console.log("...end");

            for (var i = self.audienceResponses.length; i--; ) {
              var res = self.audienceResponses[i];
              res.end();
            }

            // Close Request and cleanup
            if (self.mjpegRequest) {
              self.mjpegRequest.abort();
              self.mjpegRequest = null;
            }
            if (self.globalMjpegResponse) {
              self.globalMjpegResponse.destroy();
            }
          });
          mjpegResponse.on("close", function () {
            clearTimeout(self.to);
            // console.log("...close");

            for (var i = self.audienceResponses.length; i--; ) {
              var res = self.audienceResponses[i];
              res.end();
            }

            // Close Request and cleanup
            if (self.mjpegRequest) {
              self.mjpegRequest.abort();
              self.mjpegRequest = null;
            }
            if (self.globalMjpegResponse) {
              self.globalMjpegResponse.destroy();
            }
          });
        }
      );

      self.mjpegRequest.on("error", function (e) {
        console.error("problem with request: ", e);
        console.error("destroying request");
        self.mjpegRequest = null;
        if (self.globalMjpegResponse) {
          self.globalMjpegResponse.destroy();
        }

        // Should respond to browser
        for (var i = self.audienceResponses.length; i--; ) {
          var res = self.audienceResponses[i];
          res.end();
        }
      });
      self.mjpegRequest.end();
    }
  };

  self._newClient = function (req, res) {
    res.Buffer = false;
    res.BufferOutput = false;
    res.writeHead(200, {
      Expires: "Mon, 01 Jul 1980 00:00:00 GMT",
      'Cache-Control': 'no-cache, no-store, must-revalidate, private',
      'Age': 0,
      Pragma: "no-cache",
      "Content-Type": "multipart/x-mixed-replace;boundary=" + self.boundary,
    });

    self.audienceResponses.push(res);
    self.newAudienceResponses.push(res);

    res.socket.on("close", function () {
      // console.log('exiting client!');

      self.audienceResponses.splice(self.audienceResponses.indexOf(res), 1);
      if (self.newAudienceResponses.indexOf(res) >= 0) {
        self.newAudienceResponses.splice(
          self.newAudienceResponses.indexOf(res),
          1
        ); // remove from new
      }

      // Only destroy on flag is set
      if (
        self.options.destroyRequestOnIdle &&
        self.audienceResponses.length == 0
      ) {
        self.mjpegRequest = null;
        if (self.globalMjpegResponse) {
          self.globalMjpegResponse.destroy();
        }
      }
    });
  };

  return self;
});
