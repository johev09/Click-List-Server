var WebSocketServer = require('websocket').server;
var http = require('http');
var mysql = require('mysql');

//var host = 'localhost',
//    user = 'root',
//    password = '',
//    database = 'click_list';
var host = 'localhost',
    user = 'root',
    password = 'monty',
    database = 'click_list';
//var SERVER_IP = "127.0.0.1",
var SERVER_IP = '172.31.9.244',
    SERVER_PORT = 5001;

//keeps email => userfunc() of current online users
var online = {};

var pool = mysql.createPool({
    connectionLimit: 100, //important
    host: host,
    user: user,
    password: password,
    database: database,
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
server.listen(SERVER_PORT, SERVER_IP, function () {
    console.log((new Date()) + ' Server is listening on port ' + SERVER_PORT);
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
wsServer.on('request', newUser);

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

function newUser(request) {
    if (!originIsAllowed(request.origin)) {
        // Make sure we only accept requests from an allowed origin 
        request.reject();
        console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
        return;
    }

    try {
        //accepting connection with echo-protocol
        var connection = request.accept('echo-protocol', request.origin);

        var self = this, //pointer to current user
            useremail,
            deleted = false,
            insertUserSQL = "INSERT INTO users(email) VALUES(?) ON DUPLICATE KEY UPDATE email=?",
            insertSQL = "INSERT INTO links(sender,receiver,title,link,favicon) VALUES(?,?,?,?,?)",
            deleteSQL = "DELETE FROM links WHERE receiver=? AND lid=?",
            updateOpenedSQL = "UPDATE links SET opened=1 WHERE lid=?",
            updateReceivedSQL = "UPDATE links SET received=1 WHERE lid=?",
            //getLinksQuery = 'SELECT lid,sender,link,title,favicon from links WHERE receiver=? ORDER BY timestamp DESC',
            getLinksQuery = 'SELECT lid,sender,receiver,link,title,favicon,received,opened from links WHERE sender = ? OR receiver=? ORDER BY timestamp DESC',
            count = 0,
            lids = new Set(),
            closed = false,
            client,
            pollTimeout = 2000
        this.clientPush = true // forces data push to client        

        console.log((new Date()) + ' Connection accepted.');
        connection.on('message', function (message) {
            if (message.type === 'utf8') {
                console.log('Received Message: ' + message.utf8Data);
                try {
                    var json = JSON.parse(message.utf8Data)
                    switch (json.type) {
                    case "email":
                        {
                            useremail = json.data
                            online[useremail] = self
                                //starting thread to check for new data and send data to client
                            self.clientPush = true
                            self.pollThread()
                                //register user if not yet registered
                            poolQuery({
                                sql: insertUserSQL,
                                values: [useremail, useremail]
                            })
                            console.log("CONNECTED: " + useremail)
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
                                    response["message"] = "Link sent to " + sender
                                    response["action"] = "sent"
                                    response["lid"] = lid
                                    console.log("link sent to " + sender)

                                    if (sender in online)
                                        online[sender].clientPush = true
                                    if (receiver in online)
                                        online[receiver].clientPush = true
                                }
                                self.send(response)
                            })
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
                                self.send(response)
                                deleted = true
                            })
                        }
                    }
                } catch (err) {
                    console.error(err)
                }
                //                connection.sendUTF(message.utf8Data);
            }
        });
        connection.on('close', function (reasonCode, description) {
            closed = true
            console.log((new Date()) + ' Peer ' + connection.remoteAddress + ' disconnected.');
        });

        this.send = function (response) {
            connection.sendUTF(JSON.stringify(response))
        }
        this.pollThread = function pollThread() {
            if (closed) {
                console.log("CLIENT DISCONNECTED: " + useremail)
                    //remove from online list
                delete online[useremail]
                return
            }

            if (self.clientPush) {
                deleted = false
                self.clientPush = false

                //console.log("query", getLinksQuery)
                poolQuery({
                    sql: getLinksQuery,
                    values: [useremail, useremail]
                }, function (err, rows, fields) {
                    if (!err) {
                        //console.log("query", email, rows.length);
                        //                    var nlids = new Set()
                        //                    var nrows = 0
                        //                    rows.forEach(function (row) {
                        //                        if (row.receiver == useremail && !row.received) {
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
                        //if (nrows || deleted || self.clientPush) {

                        // senders whose links were received now should get the notification
                        rows.forEach(function (row) {
                            if (row.receiver == useremail && !row.received) {
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

                        console.log("RECEIVED", useremail, rows.length);
                        self.send({
                            success: true,
                            message: "YAY! New Links",
                            action: "data",
                            data: rows
                        })

                    } else {
                        //console.log("db err", err);
                        self.send({
                            success: false,
                            message: err
                        })
                    }
                })
            }

            setTimeout(pollThread, pollTimeout)
        }
    } catch (err) {
        console.error(err)
    }
}