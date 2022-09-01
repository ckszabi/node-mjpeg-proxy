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

var MjpegProxy = (exports.MjpegProxy = function (mjpegUrl, options, ontimeout) {
  var self = this;

  if (!mjpegUrl) throw new Error("Please provide a source MJPEG URL");

  self.mjpegOptions = new URL(mjpegUrl);
  self.options = options || {};
  self.options = Object.assign(
    { timeout: 5000, destroyRequestOnIdle: true },
    self.options
  );

  self.audienceResponses = [];

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

          // Timeout handler
          self.to = setTimeout(function () {
            mjpegResponse.emit("timeout");

            // Abort current request and remove
            for (var i = 0; i < self.audienceResponses.length; i++)
              self.audienceResponses[i].end();
            self.audienceResponses = [];
            
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

            for (var i = 0; i < self.audienceResponses.length; i++)
              self.audienceResponses[i].write(chunk);

            // Set next timeout on schedule
            self.to = setTimeout(function () {
              mjpegResponse.emit("timeout");
            }, self.options.timeout);
          });

          mjpegResponse.on("end", function () {
            clearTimeout(self.to);
            // console.log("...end");

            for (var i = 0; i < self.audienceResponses.length; i++)
              self.audienceResponses[i].end();
            self.audienceResponses = [];

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

            for (var i = 0; i < self.audienceResponses.length; i++)
              self.audienceResponses[i].end();
            self.audienceResponses = [];

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
        for (var i = 0; i < self.audienceResponses.length; i++)
          self.audienceResponses[i].end();
        self.audienceResponses = [];
      });
      self.mjpegRequest.end();
    }
  };

  self._newClient = function (req, res) {
    res.writeHead(200, {
      Expires: "Mon, 01 Jul 1980 00:00:00 GMT",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      "Content-Type": "multipart/x-mixed-replace;boundary=" + self.boundary,
    });

    self.audienceResponses.push(res);

    res.socket.on("close", function () {
      // console.log('exiting client!');

      self.audienceResponses.splice(self.audienceResponses.indexOf(res), 1);

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
