var config = require('./config');

var WebSocketServer = require('websocket').server;
var http = require('http');
var mysql = require('mysql');

var nodemailer = require('nodemailer');
var fs = require('fs');

var mailer = {
    mailto: function (email, fromMail) {
        if (!this.ready)
            return console.log("Mailed not ready", email, fromMail)

        // setup e-mail data with unicode symbols
        var text = "You have unread links from " + fromMail + "\n\n" +
            "Install Click List Chrome Extension to view your links. Link given below" + "\n\n" +
            "https://chrome.google.com/webstore/detail/click-list/alhkmhmifgefbkkooliaapebilcjbddo";

        //        var html = "<p>You have <b>unread links</b> from <i>" + fromMail + "</i><br><br>" +
        //            "You can install Click List Chrome Extension to view your links" + "<br><br>" +
        //            "<a href='https://chrome.google.com/webstore/detail/click-list/alhkmhmifgefbkkooliaapebilcjbddo?utm_source=gmail'>INSTALL</a>";

        var html = this.html
        html = html.replace(config.mail.htmlFromRegex, fromMail);

        var mailOptions = {
            from: config.mail.name + " <" + config.mail.email + ">", // sender address 
            to: email, // list of receivers 
            subject: config.mail.subject, // Subject line 
            text: text, // plaintext body 
            html: html // html body 
        };

        // send mail with defined transport object 
        this.transporter.sendMail(mailOptions, function (error, info) {
            if (error) {
                return console.log(error);
            }
            console.log("Mail sent to: " + email + ", from: " + fromMail);
            console.log('Message sent: ' + info.response);
        });
    },
    init: function () {
        this.ready = false;
        this.transporter = nodemailer.createTransport(config.mail.hostURL);
        fs.readFile(config.mail.htmlFile, function read(err, data) {
            if (err) {
                return console.log(err);
            }

            this.html = data.toString()
            this.ready = true;
        }.bind(this))
    }
}
mailer.init.call(mailer);

//keeps email => userfunc() of current online users
var online = {};

var pool = mysql.createPool({
    connectionLimit: 100, //important
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    debug: false
});

function poolQuery(options, cb) {
    var sql = options.sql,
        values = options.values ? options.values : []

    pool.getConnection(function (err, dbconn) {
        if (err) {
            console.error("db err", err)
            return;
        }

        //console.log('connected as id ' + dbconn.threadId);
        //console.log(values)
        dbconn.query({
            sql: sql,
            values: values
        }, function (err, rows, fields) {
            dbconn.release();
            if (err) {
                console.error("db err", err);
                return;
            }
            if (cb)
                cb(err, rows, fields)
        });

        dbconn.on('error', function (err) {
            console.error("db err", err)
            return;
        });
    });
}

var server = http.createServer(function (request, response) {
    console.log((new Date()) + ' Received request for ' + request.url);
    response.writeHead(404);
    response.end();
});
server.listen(config.server.port, config.server.host, function () {
    console.log((new Date()) + ' Server is listening on ' + config.server.host + ":" + config.server.port);
});

wsServer = new WebSocketServer({
    httpServer: server,
    // You should not use autoAcceptConnections for production 
    // applications, as it defeats all standard cross-origin protection 
    // facilities built into the protocol and the browser.  You should 
    // *always* verify the connection's origin and decide whether or not 
    // to accept it. 
    autoAcceptConnections: false
});
wsServer.on('request', function (request) {
    if (!originIsAllowed(request.origin)) {
        // Make sure we only accept requests from an allowed origin 
        request.reject();
        console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
        return;
    }

    c = new client(request)
});

function originIsAllowed(origin) {
    // put logic here to detect whether the specified origin is allowed.
    console.log("ORIGIN: " + origin)
    if (origin === "chrome-extension://cpgdgcfiphfbeanaipacpodjialglgfj" || /*johev linux*/
        origin === "chrome-extension://dneclmipkeoeghnhkfadlfhanbgdckab" || /*johev win*/
        origin === "chrome-extension://jojjnjbclikobcmhdohhdipnaddgiiod" || /*shristi win*/
        origin === "chrome-extension://alhkmhmifgefbkkooliaapebilcjbddo" /*webstore*/ )
        return true
    return false;
}

function userExists(receiver, sender) {
    poolQuery({
        sql: "SELECT email from users WHERE email = ?",
        values: [receiver]
    }, function (err, rows, fields) {
        if (err || rows.length)
            return;

        mailer.mailto.call(mailer, receiver, sender);
    });
}

var insertUserSQL = "INSERT INTO users(email) VALUES(?) ON DUPLICATE KEY UPDATE email=?",
    insertSQL = "INSERT INTO links(sender,receiver,title,link,favicon) VALUES(?,?,?,?,?)",
    deleteSQL = "DELETE FROM links WHERE receiver=? AND lid=?",
    updateOpenedSQL = "UPDATE links SET opened=1 WHERE lid=?",
    updateReceivedSQL = "UPDATE links SET received=1 WHERE lid=?",
    //getLinksQuery = 'SELECT lid,sender,link,title,favicon from links WHERE receiver=? ORDER BY timestamp DESC',
    getLinksQuery = 'SELECT lid,sender,receiver,link,title,favicon,received,opened from links WHERE sender = ? OR receiver=? ORDER BY timestamp DESC',
    count = 0,
    lids = new Set(),
    pollTimeout = 2000

function client(request) {
    var self = this
    this.closed = false
    this.useremail = undefined
    this.clientPush = true // forces data push to client  
    this.onmessage = function (message) {
        if (message.type === 'utf8') {
            console.log('Received Message: ' + message.utf8Data);
            try {
                var json = JSON.parse(message.utf8Data)
                switch (json.type) {
                case "email":
                    {
                        this.useremail = json.data
                        online[this.useremail] = this

                        //starting thread to check for new data and send data to client
                        this.clientPush = true
                        this.pollThread.call(this);
                        //register user if not yet registered
                        poolQuery({
                            sql: insertUserSQL,
                            values: [this.useremail, this.useremail]
                        })
                        console.log("CONNECTED: " + this.useremail)
                    }
                    break

                case "opened":
                    {
                        var data = json.data,
                            lid = data.lid,
                            sender = data.sender,
                            receiver = data.receiver

                        poolQuery({
                            sql: updateOpenedSQL,
                            values: [lid]
                        }, function (err, rows, fields) {
                            if (!err) {
                                if (sender in online)
                                    online[sender].clientPush = true
                                if (receiver in online)
                                    online[receiver].clientPush = true
                            }
                        })
                    }
                    break

                case "send":
                    {
                        var data = json.data,
                            sender = data.sender,
                            receiver = data.receiver,
                            title = data.title,
                            link = data.link,
                            favicon = data.favicon,
                            lid = data.lid

                        poolQuery({
                            sql: insertSQL,
                            values: [sender, receiver, title, link, favicon]
                        }, function (err, rows, fields) {
                            var response = {};
                            if (err) {
                                response["success"] = false;
                                response["message"] = "db err"
                                console.log("send insert db err", err)
                            } else {
                                response["success"] = true
                                response["message"] = "Link sent to " + receiver
                                response["action"] = "sent"
                                response["lid"] = lid
                                console.log("link sent to " + receiver)

                                if (sender in online)
                                    online[sender].clientPush = true
                                if (receiver in online)
                                    online[receiver].clientPush = true
                            }
                            self.send.call(self, response)
                        })

                        setTimeout(userExists.bind(this, receiver, sender));
                    }
                    break

                case "delete":
                    {
                        var data = json.data,
                            lid = data.lid,
                            receiver = data.email,
                            sender = data.sender
                        poolQuery({
                            sql: deleteSQL,
                            values: [receiver, lid]
                        }, function (err, rows, fields) {
                            var response = {};
                            if (err) {
                                response["success"] = false
                                response["message"] = "db err"
                                console.log("delete db err", err)
                            } else {
                                response["success"] = true
                                response["message"] = "link deleted"
                                response["action"] = "deleted"
                                response["lid"] = lid
                                console.log("link deleted: " + lid)
                                if (sender in online) {
                                    online[sender].clientPush = true
                                }
                                if (receiver in online) {
                                    online[receiver].clientPush = true
                                }
                            }
                            self.send.call(self, response)
                        })
                    }
                }
            } catch (err) {
                console.error(err)
            }
            //                connection.sendUTF(message.utf8Data);
        }
    }
    this.onclose = function (reasonCode, description) {
        //remove from online list
        delete online[this.useremail]
        this.closed = true
        console.log((new Date()) + ' Peer ' + this.connection.remoteAddress + ' disconnected.');
        console.log("CLIENT DISCONNECTED: " + this.useremail)
    }
    this.send = function (response) {
        this.connection.sendUTF(JSON.stringify(response))
    }
    this.pollThread = function () {
        //console.log(this.useremail, "thread running...")
        if (this.closed) {
            console.log("CLIENT THREAD CLOSED: " + this.useremail)
            return
        }

        if (this.clientPush) {
            this.clientPush = false

            //console.log("query", getLinksQuery)
            poolQuery({
                sql: getLinksQuery,
                values: [this.useremail, this.useremail]
            }, function (err, rows, fields) {
                if (!err) {
                    //console.log("query", email, rows.length);
                    //                    var nlids = new Set()
                    //                    var nrows = 0
                    //                    rows.forEach(function (row) {
                    //                        if (row.receiver == this.useremail && !row.received) {
                    //                            var sender = row.sender
                    //                            poolQuery({
                    //                                sql: updateReceivedSQL,
                    //                                values: [row.lid]
                    //                            }, function (err, rows, fields) {
                    //                                if (!err && sender in online)
                    //                                    online[sender].clientPush = true
                    //                            })
                    //                        }
                    //
                    //                        if (!lids.has(row.lid))
                    //                            ++nrows
                    //                        nlids.add(row.lid)
                    //                    })
                    //                    lids = nlids
                    //if (nrows || deleted || this.clientPush) {

                    // senders whose links were received now should get the notification
                    rows.forEach(function (row) {
                        if (row.receiver == self.useremail && !row.received) {
                            var sender = row.sender
                            poolQuery({
                                sql: updateReceivedSQL,
                                values: [row.lid]
                            }, function (err, rows, fields) {
                                if (!err && sender in online)
                                    online[sender].clientPush = true
                            })
                        }
                    })

                    console.log("RECEIVED", self.useremail, rows.length);
                    self.send.call(self, {
                        success: true,
                        message: "YAY! New Links",
                        action: "data",
                        data: rows
                    })

                } else {
                    //console.log("db err", err);
                    self.send.call(self, {
                        success: false,
                        message: err
                    })
                }
            })
        }

        setTimeout(this.pollThread.bind(this), pollTimeout)
    }

    this.connection = request.accept('echo-protocol', request.origin);
    console.log((new Date()) + ' Connection accepted.');
    this.connection.on('message', this.onmessage.bind(this));
    this.connection.on('close', this.onclose.bind(this));
}