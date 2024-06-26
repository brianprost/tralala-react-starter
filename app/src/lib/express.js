'use-strict';
const { getSessionStore } = require('./passport');
const { parseAssetPaths } = require('./webpack');
const compression = require('compression');
const session = require('express-session');
const bodyParser = require('body-parser');
const container = require('./winston');
const logger = container.get('console');
const passport = require('passport');
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

/**
 * @class Server
 * @description Logging container for the application
 */
module.exports = class Server {
	constructor(config) {
		// Setup express
		this.app = express();
		this.config = config;
		// Always return self for chaining
		return this;
	}

	/**
	 * @method configureMiddleware
	 * @description Enable all the standard middleware
	 */
	configureMiddleware() {
		this.app.set('showStackError', true);
		this.app.set('jsonp callback', true);
		this.app.use(compression({ level: 9 }));
		this.app.use(bodyParser.urlencoded({ extended: true }));
		this.app.use(bodyParser.json());

		return this;
	}

	/**
	 * @method configureMiddleware
	 * @description Enable all the standard middleware
	 * @param {object} locals - Locals for express to use in rendering pages
	 */
	configureLocals(locals = {}) {
		this.app.locals.title = locals.title;
		this.app.locals.author = locals.author;
		this.app.locals.keyword = locals.keyword;
		this.app.locals.description = locals.description;
		this.app.locals.contentSecurityPolicy = locals.contentSecurityPolicy;

		return this;
	}

	/**
	 * @method configureCors
	 * @description If desired, adds a global cors configuration
	 * Not designed, to have the config pass in a function if you need dynamic cors
	 * updates, like from a database. If that need happens, modify this function
	 */
	configureCors() {
		this.app.use(cors(this.config.cors.config));
		return this;
	}

	/**
	 * @method configureSession
	 * @description Set up express session
	 */
	configureSession() {
		this.app.use(
			session({
				...this.config.session,
				...{
					store: getSessionStore(),
				}
			}),
		);

		return this;
	}

	/**
	 * @method configurePassport
	 * @description Set up passport and strategies
	 */
	configurePassport() {
		this.app.use(passport.initialize());
		this.app.use(passport.session());
		// Configure passport and setup and strategies
		require('./passport').initialize(passport);

		return this;
	}

	/**
	 * @method configureViewEngine
	 * @description Set the default view engine to use with express
	 * @param {string} engine="default" - View engine to use
	 * @param {string} views="" - Comma separated list of views
	 */
	configureViewEngine(engine = 'pug', views = '') {
		this.app.set('view engine', engine);
		this.app.set('views', views);

		return this;
	}

	/**
	 * @method configureHelmet
	 * @description Enable default settings for security related express headers
	 * See https://helmetjs.github.io/ for defaults
	 */
	configureHelmet(config) {
		this.app.use(helmet(config));

		return this;
	}

	/**
	 * @method setPublicDirectory
	 * @description Set public directory to load assets from
	 * @param {string} directory='' - directory in bin we want to expose as public
	 * @note `bin` is the directory we build static assets in, if that changes
	 * we need to update the default setting here
	 */
	setPublicDirectory(directory = '') {
		this.app.use('/public', express.static(path.join('bin', directory)));

		return this;
	}

	/**
	 * @method setPublicRoutes
	 * @description Set any public routes
	 * @param {string} - Mode to load api endpoints in. Either LAMBDA of DEFAULT.
	 * 					 LAMBDA loads the lambda endpoints and sends the information as if
	 * 					 were in lambda for emulation purposes
	 * 					 DEFAULT loads the normal endpoints if running in a server
	 * @param {Object<Array<string>>} files={} - Array of filepaths to modules that expose
	 * a single function that accepts an express app as it's argument and uses that
	 * to set itself up with express
	 */
	setPublicRoutes(apiMode = 'default', files = {}) {
		if (apiMode == 'LAMBDA') {
			let { handler } = require(files.lambda);
			this.app.use(async (req, res, next) => {
				const uri = req.baseUrl + (req.path != '/' ? req.path : '');
				try {
					let {statusCode, headers, body} = await handler({
						headers: [],
						body: req.body,
						queryStringParameters: req.query,
						requestContext: {
							domainName: req.get('host'),
							domainPrefix: '',
							httpMethod: req.method,
							identity: {
								accessKey: null,
								accountId: null,
								caller: null,
								cognitoAmr: null,
								cognitoAuthenticationProvider: null,
								cognitoAuthenticationType: null,
								cognitoIdentityId: null,
								cognitoIdentityPoolId: null,
								principalOrgId: null,
								sourceIp: '127.0.0.1',
								user: null,
								userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36',
								userArn: null
							},
							path: uri,
							protocol: 'HTTP/1.1',
							requestTime: new Date().toISOString(),
							requestTimeEpoch: new Date().valueOf(),
							resourceId: `${req.method} ${uri}`,
							resourcePath: uri,
						}
					});
					res.status(statusCode).set(headers).send(body);
				} catch (e) {
					next();
				}
			});	
		} else {
			logger.debug(JSON.stringify(files.routes, null, 4));
			files.routes.forEach((route) => this.app.use(require(route)));
		}

		return this;
	}

	/**
	 * @method setSPARoute
	 * @description Add an endpoint for the single page application
	 */
	setSPARoute() {
		let statsPath = path.resolve('bin/stats.json');
		let binPath = path.resolve('bin');
		let css = '';
		// This is a catch all for the SPA, you should be mindful when developing
		// not to have any public routes that match routes defined in your client
		// side router. The public routes would get invoked and block your SPA from
		// loading the correct content on a page refresh
		this.app.get('*', (req, res) => {
			logger.debug('Received request on ' + req.path);
			// Grab our stats, this will be cached in production
			if (process.env.NODE_ENV === 'development') {
				delete require.cache[statsPath];
			}

			let stats = require(statsPath);
			// Parse out code paths and styles, the format of this changes from
			// development to production. The main chunk in dev is a string, in prod,
			// it is an array with the path to a css asset that needs to be inlined
			let { js: jsCommon } = parseAssetPaths(stats.assetsByChunkName.common || '');
			let { css: cssMain, js: jsMain } = parseAssetPaths(stats.assetsByChunkName.main);

			// Grab our css file as plaintext
			if (cssMain) {
				css = fs.readFileSync(path.join(binPath, stats.publicPath, cssMain), {
					encoding: 'utf-8',
				});
			}

			// Send back our core template
			res.status(200).render('core', {
				commonSrc: path.join(stats.publicPath, jsCommon),
				mainSrc: path.join(stats.publicPath, jsMain),
				css: css,
			});
		});

		return this;
	}

	/**
	 * @method listen
	 * @description Start listening on the configured port
	 * @param {number} port - Defualt port to listen on
	 * @param {function} [callback] - Optional callback for listen
	 */
	listen(port, callback) {
		let server;
		if (this.config.listener.enableSsl) {
			logger.debug('Starting the server in SSL mode');
			server = require('https').createServer({
				key: this.config.listener.sslKey,
				cert: this.config.listener.sslCert,
				// The passphrase can be undefined if it does not matter
				passphrase: this.config.listener.sslKeyPassphrase
			}, this.app);
		} else {
			logger.debug('Starting the server in a non SSL mode');
			server = require('http').createServer(this.app);
		}
		
		server.listen(port, callback);

		return this;
	}
};
