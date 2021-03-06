const asyncio = require("async");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const Grant = require("grant-express");
const ws = require("@clusterws/cws");
const PostgresStore = require("connect-pg-simple")(session);
const Sentry = require('@sentry/node');

const config = require("./lib/config");
const reddit = require("./lib/reddit");
const db = require("./lib/database");

Sentry.init({
    dsn: config.sentry
});

const grantOpts = {
    server: {
        protocol: config.protocol || "http",
        host: config.host,
        callback: "/auth/callback",
        transport: "querystring",
        state: true
    },
    reddit: {
        key: config.reddit.client_id,
        secret: config.reddit.client_secret,
        scope: ["identity"],
        custom_params: {
            duration: "permanent"
        }
    }
};

const grant = new Grant(grantOpts);
const app = express();
const server = http.createServer(app);
const wss = new ws.WebSocketServer({ server });

function connectToRedditSocket() {
    reddit.getWebSocket().then(url => {
        const redditws = new ws.WebSocket(url);

        redditws.on("message", (data) => parseRedditMessage( JSON.parse(data) ));
        redditws.on("error", err => {
            console.error(err);
            Sentry.captureException(err);
        });

        redditws.on("close", () =>
            setTimeout(connectToRedditSocket, 5000)
        );
    });
}

connectToRedditSocket();

const state = {
    chapters: {},
    scenes: {},
    postCache: {},
    wsClientCount: 0,
    currentChapter: -1
};

app.set("view engine", "pug");

app.use("/static", express.static(`${__dirname}/static`));
app.use(session({
    secret: config.secret,
    resave: true,
    saveUninitialized: true,
    store: new PostgresStore({pool: db.pool})
})
);
app.use(grant);

app.get("/v1/targets", (req, res) =>
    db.getAllSortedScenes().then(scenes =>
        asyncio.map(scenes, (s, cb) => {
            let scene = s.scene_id;
            let data = { scene, chapter: state.currentChapter, fullname: s.fullname };

            if (state.postCache[s.fullname]) {
                let post = state.postCache[s.fullname];

                if (Date.now() - post.cache_time < 1800000) {
                    data.extra = { url: post.url, start_time: post.created_utc };
                    return cb(null, data);
                }
            }
            
            reddit.fetchPost(s.fullname).then(post => {
                state.postCache[post.name] = post;
                state.postCache[post.name].cache_time = Date.now();
                
                data.extra = { url: post.url, start_time: post.created_utc };
                cb(null, data);
            });
        }, (err, results) => res.send({ targets: results }))
    ).catch(err => {
        res.send({
            "error": "problem retrieving the scenes :("
        });
        Sentry.captureException(err);
    })
);

app.get("/auth/callback", function(req, res, next) {
    const data = req.query;
    req.session.user = {
        access_token: data.access_token,
        refresh_token: data.refresh_token
    };
    
    // schedule database insert for signed in user
    process.nextTick(function() {
        const re = new reddit.Client(data.access_token, data.refresh_token);
        return re.getUserInfo().then(u => db.insertUser(u.id, u.name, data.access_token, data.refresh_token));
    });

    req.session.save((err) => {
        if (err) {
            return next(err);
        }
        
        return res.redirect(config.loggedInRedirect);
    })
});

app.use(function(req, res, next) {
    if (req.session.user) {
        req.reddit = new reddit.Client(req.session.user.access_token, req.session.user.refresh_token);
    }
    return next();
});

app.use("/admin", function(req, res, next) {
    if (!req.session.user) {
        return res.redirect("/connect/reddit");
    }
    
    return req.reddit.getUserInfo().then(function(user) {
        req.user = (res.locals.user = user);
        req.scheduleAuditLog = (desc) => {
            process.nextTick(() =>
                db.recordAuditTrail(req.user.id, req.method, req.originalUrl, desc)
                    .catch(err => console.error(err))
            );
        }
        
        return db.getUser(user.id).then(function(dbuser) {
            if (dbuser.admin || config.administrators.indexOf(dbuser.id) > -1) {
                // req.scheduleAuditLog("HTTP call");
                
                return next();
            } else {
                return res.status(401).send("You're not an administrator!");
            }
        }).catch(err => next(err));
    }).catch(err =>
        req.reddit.refreshToken().then(() => {
            req.session.user.access_token = req.reddit.access_token;

            req.session.save(() =>
                res.redirect(req.originalUrl)
            );
        })
    ).catch(err =>
        next(err)
    );
});

app.get("/admin/dash", (req, res) =>
    Promise.all([
        db.fastCount("users"),
        db.fastCount("scenes")
    ]).then(function(n) {
        const stats = {
            users: n[0],
            scenes: n[1],
            chapter: state.currentChapter,
            wsClients: state.wsClientCount
        };
        
        return res.render("admin.pug", {stats, scenes: state.scenes});
    })
);

app.get("/admin/dash/users", (req, res, next) =>
    db.getAllUsers()
        .then(users => res.render("admin-users.pug", { users }))
        .catch(err => next(err))
);

app.get("/admin/dash/audit/:page", (req, res, next) =>
    Promise.all([
        db.getAuditPage(30, 30 * (parseInt(req.params.page) - 1)),
        db.totalAuditPages(30)
    ]).then(a => ({ audit: a[0], totalPages: a[1] }) )
        .then(tup => res.render("admin-audit.pug", { ...tup, page: parseInt(req.params.page) }))
        .catch(err => next(err))
);

app.get("/admin/dash/scenes", (req, res, next) =>
    db.getAllSortedScenes()
        .then(scenes => res.render("admin-circles.pug", { scenes, redditScenes: state.scenes }))
        .catch(err => next(err))
);

app.post("/admin/dash/scenes", bodyParser.urlencoded({ extended: false }), (req, res, next) =>
    (req.body.postUrl ?
        reddit.fetchUrlInfo(req.body.postUrl).then(post =>
            post.name || req.body.fullname
        ) :
        Promise.resolve(req.body.fullname)
    ).then((fullname) => {
        if (fullname == null)
            throw new Error("Invalid post URL! It should look like this: https://www.reddit.com/r/sequence/comments/b8ftwe/act_2_scene_32/");
        else return fullname
    }).then(fullname =>
        db.addSceneItem(req.body.sceneId, fullname)
        .then(() => {
            req.scheduleAuditLog(`Added post [reddit:${fullname}] as target for scene ${req.body.sceneId}`);
            broadcastScenes();
            
            res.redirect("/admin/dash/scenes");
        })
    ).catch(err => next(err))
);

app.get("/admin/dash/scenes/deleteall", (req, res, next) =>
    db.deleteAllScenes()
        .then(() => {
            req.scheduleAuditLog("Deleted all scenes.");
            broadcastScenes();

            res.redirect("/admin/dash/scenes");
        }).catch(err => next(err))
);

app.get("/admin/dash/scenes/:id/delete", (req, res, next) =>
    db.deleteScene(req.params.id)
        .then(() => {
            req.scheduleAuditLog(`Deleted entry for scene ${req.params.id}`);
            broadcastScenes();
            
            res.redirect("/admin/dash/scenes");
        }).catch(err => next(err))
);

app.get("/admin/dash/users/:id/make_admin", (req, res, next) =>
    db.setUserAdmin(req.params.id, true)
        .then(() => req.scheduleAuditLog(`Made user [user:${req.params.id}] an admin.`))
        .then(() => res.redirect("/admin/dash/users"))
        .catch(err => next(err))
);

app.get("/admin/dash/users/:id/delete", (req, res, next) =>
    db.deleteUser(req.params.id)
        .then(() => req.scheduleAuditLog(`Removed user [user:${req.params.id}]`))
        .then(() => res.redirect("/admin/dash/users"))
        .catch(err => next(err))
);

app.get("/admin/dash/users/:id/revoke_admin", (req, res, next) =>
    db.setUserAdmin(req.params.id, false)
        .then(() => req.scheduleAuditLog(`Revoked admin of user [user:${req.params.id}]`))
        .then(() => res.redirect("/admin/dash/users"))
        .catch(err => next(err))
);

app.get("/admin/info", (req, res, next) => res.send(req.user));

app.get("/admin/logout", (req, res, next) =>
    req.session.destroy(err => {
        if (err) return next(err);

        return res.render("logged-out.pug");
    })
);

app.use(function(err, req, res, next) {
    if (!res.locals.user) {
        res.locals.user = {name: "unknown"};
    }
    
    if (err) Sentry.captureException(err);

    return res.render("error.pug", {error: err});
});

function handleSocketMessage(msg) {
    if (msg.type == "science") {
        // todo: read params
        db.recordScience(msg.uuid, msg.upvoted);
    }
}

function broadcastScenes(socket) {
    db.getAllScenes().then(scenes => {
        let data = JSON.stringify({ "type": "scenes", "fullnames": scenes.map(s => s.fullname) })

        if (socket)
            socket.send(data);
        else
            wss.broadcast(data);
    });
}

wss.on("connection", (socket) => {
    broadcastScenes(socket);
    
    socket.on("message", (data) =>
        handleSocketMessage(JSON.parse(data))
    );

    socket.on("close", () =>
        state.wsClientCount--
    );

    socket.on("error", (err) =>
        Sentry.captureException(err)
    );

    state.wsClientCount++;
});

function parseRedditMessage(msg) {
    if (msg.type == "heartbeat") {
        state.scenes = {};

        Object.keys(msg.payload.remaining_scenes).forEach(key => {
            let keys = key.split("_");
            let chapterid = parseInt(keys[0]);
            let scene = parseInt(keys[1]);

            let chapter = state.chapters[chapterid];
            if (!chapter) chapter = { scenes: [] };
            if (!chapter.scenes) chapter.scenes = [];

            chapter.scenes[scene] = msg.payload.remaining_scenes[key];
            state.scenes[scene] = msg.payload.remaining_scenes[key];
            state.chapters[chapterid] = chapter;
            state.currentChapter = chapterid;
        });
    }
}

server.listen(4003);
