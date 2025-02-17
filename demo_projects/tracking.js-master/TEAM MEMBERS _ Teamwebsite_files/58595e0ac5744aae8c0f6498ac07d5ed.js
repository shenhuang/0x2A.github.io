// Sentry Loader
(function(
  _window,
  _document,
  _script,
  _onerror,
  _onunhandledrejection,
  _namespace,
  _publicKey,
  _sdkBundleUrl,
  _config
) {
  var lazy = true;
  var forceLoad = false;

  for (var i = 0; i < document.scripts.length; i++) {
    if (document.scripts[i].src.indexOf(_publicKey) > -1) {
      lazy = !(document.scripts[i].getAttribute('data-lazy') === 'no');
      break;
    }
  }

  var injected = false;
  var onLoadCallbacks = [];

  // Create a namespace and attach function that will store captured exception
  // Because functions are also objects, we can attach the queue itself straight to it and save some bytes
  var queue = function(content) {
    // content.e = error
    // content.p = promise rejection
    // content.f = function call the Sentry
    if (
      (content.e ||
        content.p ||
        (content.f && content.f.indexOf('capture') > -1) ||
        (content.f && content.f.indexOf('showReportDialog') > -1)) &&
      lazy
    ) {
      // We only want to lazy inject/load the sdk bundle if
      // an error or promise rejection occured
      // OR someone called `capture...` on the SDK
      injectSdk(onLoadCallbacks);
    }
    queue.data.push(content);
  };
  queue.data = [];

  function injectSdk(callbacks) {
    if (injected) {
      return;
    }
    injected = true;

    // Create a `script` tag with provided SDK `url` and attach it just before the first, already existing `script` tag
    // Scripts that are dynamically created and added to the document are async by default,
    // they don't block rendering and execute as soon as they download, meaning they could
    // come out in the wrong order. Because of that we don't need async=1 as GA does.
    // it was probably(?) a legacy behavior that they left to not modify few years old snippet
    // https://www.html5rocks.com/en/tutorials/speed/script-loading/
    var _currentScriptTag = _document.getElementsByTagName(_script)[0];
    var _newScriptTag = _document.createElement(_script);
    _newScriptTag.src = _sdkBundleUrl;
    _newScriptTag.crossorigin = 'anonymous';

    // Once our SDK is loaded
    _newScriptTag.addEventListener('load', function() {
      try {
        // Restore onerror/onunhandledrejection handlers
        _window[_onerror] = _oldOnerror;
        _window[_onunhandledrejection] = _oldOnunhandledrejection;

        var SDK = _window[_namespace];

        var oldInit = SDK.init;

        // Configure it using provided DSN and config object
        SDK.init = function(options) {
          var target = _config;
          for (var key in options) {
            if (Object.prototype.hasOwnProperty.call(options, key)) {
              target[key] = options[key];
            }
          }
          oldInit(target);
        };

        sdkLoaded(callbacks, SDK);
      } catch (o_O) {
        console.error(o_O);
      }
    });

    _currentScriptTag.parentNode.insertBefore(_newScriptTag, _currentScriptTag);
  }

  function sdkLoaded(callbacks, SDK) {
    try {
      for (var i = 0; i < callbacks.length; i++) {
        if (typeof callbacks[i] === 'function') {
          callbacks[i]();
        }
      }

      var data = queue.data;

      // We want to replay all calls to Sentry first to make sure init is called before
      // we call all our internal error handlers
      var firstInitCall = false;
      var calledSentry = false;
      for (var i = 0; i < data.length; i++) {
        if (data[i].f) {
          calledSentry = true;
          var call = data[i];
          if (firstInitCall === false && call.f !== 'init') {
            // First call always has to be init, this is a conveniece for the user
            // so call to init is optional
            SDK.init();
          }
          firstInitCall = true;
          SDK[call.f].apply(SDK, call.a);
        }
      }
      if (calledSentry === false) {
        // Sentry has never been called but we need Sentry.init() so call it
        SDK.init();
      }
      // Because we installed the SDK, at this point we have an access to TraceKit's handler,
      // which can take care of browser differences (eg. missing exception argument in onerror)
      var tracekitErrorHandler = _window[_onerror];
      var tracekitUnhandledRejectionHandler = _window[_onunhandledrejection];

      // And now capture all previously caught exceptions
      for (var i = 0; i < data.length; i++) {
        if (data[i].e && tracekitErrorHandler) {
          tracekitErrorHandler.apply(_window, data[i].e);
        } else if (data[i].p && tracekitUnhandledRejectionHandler) {
          tracekitUnhandledRejectionHandler.apply(_window, [data[i].p]);
        }
      }
    } catch (o_O) {
      console.error(o_O);
    }
  }

  // We don't want to _window.Sentry = _window.Sentry || { ... } since we want to make sure
  // that the first Sentry "instance" is our with onLoad
  _window[_namespace] = {
    onLoad: function (callback) {
      onLoadCallbacks.push(callback);
      if (lazy && !forceLoad) {
        return;
      }
      injectSdk(onLoadCallbacks);
    },
    forceLoad: function() {
      forceLoad = true;
      if (lazy) {
        setTimeout(function() {
          injectSdk(onLoadCallbacks);
        });
      }
    }
  };

  [
    'init',
    'addBreadcrumb',
    'captureMessage',
    'captureException',
    'captureEvent',
    'configureScope',
    'withScope',
    'showReportDialog'
  ].forEach(function(f) {
    _window[_namespace][f] = function() {
      queue({ f: f, a: arguments });
    };
  });

  // Store reference to the old `onerror` handler and override it with our own function
  // that will just push exceptions to the queue and call through old handler if we found one
  var _oldOnerror = _window[_onerror];
  _window[_onerror] = function(message, source, lineno, colno, exception) {
    // Use keys as "data type" to save some characters"
    queue({
      e: [].slice.call(arguments)
    });

    if (_oldOnerror) _oldOnerror.apply(_window, arguments);
  };

  // Do the same store/queue/call operations for `onunhandledrejection` event
  var _oldOnunhandledrejection = _window[_onunhandledrejection];
  _window[_onunhandledrejection] = function(exception) {
    queue({
      p: exception.reason
    });
    if (_oldOnunhandledrejection) _oldOnunhandledrejection.apply(_window, arguments);
  };

  if (!lazy) {
    setTimeout(function() {
      injectSdk(onLoadCallbacks);
    });
  }
})(window, document, "script", "onerror", "onunhandledrejection", "Sentry", "58595e0ac5744aae8c0f6498ac07d5ed", "https://browser.sentry-cdn.com/4.6.2/bundle.min.js", {"dsn":"https://58595e0ac5744aae8c0f6498ac07d5ed@sentry.io/1372726"});
