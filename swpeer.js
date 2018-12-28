configfile = './config.json';
//Enable full path
config = require(configfile);

_ = require('underscore/underscore.js')._;
Promise = require('es6-promise').Promise;
Events = require('./events.js');
http = require('http');

WebSocket = require('websocket').client;

var signalR = require('signalr-client');


//Set env var to accept all certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
Cow = require('cow/dist/cow.nodb.js');

core = new Cow.core({
    herdname: config.herdname,
    maxage: 1000 * 60 * 60 * 24 * 365 //one year
});
if (!core.socketservers('default')){
   core.socketservers({
        _id: 'default',
        data: {
        	protocol: config.protocol,
        	ip: config.ip,
        	port: config.port,
        	dir: config.dir}
      });
};
core.socketserver('default');
core.connect();
core.userStore().synced.then(function(){
	var user = core.users({_id: 'geodan_connector'});
	user.data({
			name: 'Geodan connector',
			type: 'swconnector'
	}).sync();
	core.user('geodan_entrancecam');
	console.log(core.users().length, ' users loaded');
 core.peer().data('family','stupid').sync();
        console.log('I am ', core.peer().data('family'));

});

core.projectStore().synced.then(function(){
	console.log(core.projects().length, ' projects loaded');
	core.peer().data('swpeer', true).sync();
	console.log('My peerid: ', core.peerid());
});

core.projectStore().synced.then(function(){
    load_sw();
});
core.projectStore().loaded.then(function(){
    console.log('numprojects: ',core.projects().length);
    //load_sw();
})

/* Working on the connector connection */




var querystring = require('querystring');
var inspect = require('eyespect').inspector();
var request = require('request');
var apiurl = 'http://eo-iis-dev-swapp.geodan.nl/connector-prorail/api/';

function crud_task(project,task){
    var taskid = task.taskId.toString();
    //Check to see if task exists
    if (!project.items(taskid)){
        return project.items({_id: taskid}).data(task).sync();
    }
    else {
        var item = project.items(taskid);
        //Check to see if it is updated
        var date_old = new Date(item.data('lastModifiedDateTime'));
        var date_new = new Date(item.lastModifiedDateTime);
        if (date_new > date_old){
            item.data(task).sync();
        }
        return item;
    }
}

function load_tasks(token,incidentid){
    var options = {
      method: 'get',
      headers: {token: token},
      json: true,
      url: apiurl + 'Task/'+incidentid+'?jobTitleId=26149'
    }
    request(options,function(err, res, body){
        if (err) {
          inspect(err, 'error posting json')
          return
        }
        var headers = res.headers;
        var statusCode = res.statusCode;
        if (!body){
            inspect(headers, 'headers')
            inspect(statusCode, 'statusCode')
            inspect(body, 'body')
        }
        if (body && body.incidentTasks){
            body.incidentTasks.forEach(function(d){
                var project = core.projects(d.incidentId.toString());
                if (!project){
                    throw 'Should have been a project with id' + d.incidentId;
                }
                if (project){
                    d.tasks.forEach(function(t){
                        var task = crud_task(project,t);
                    });
                    console.log('project',d.incidentId,'has ',project.items().length,'tasks');
                }
                else console.log('no project with id ',d.incidentId);
            });
        }
    });
}

function crud_incident(incident){
    var incidentid = incident.incidentId.toString();
    var subIncidentIds = incident.childIncidents?incident.childIncidents.map(function(d){
        return d.incidentId;
    }):[];
    //Map to more consise data
    var data = {
        subIncidentIds: subIncidentIds,
        acknowledgedBy: incident.acknowledgedBy,
        closureTimeDateTime: incident.closureTimeDateTime,
        collaboratorsLgIds: incident.collaboratorsLgIds,
        collaboratorsUserIds: incident.collaboratorsUserIds,
        createdBy: incident.createdBy,
        creationTimeDateTime: incident.creationTimeDateTime,
        incidentId: incident.incidentId,
        incidentType: incident.incidentType,
        incidentTypeName: incident.incidentTypeName,
        isEscalated: incident.isEscalated,
        isIntakeIncident: incident.isIntakeIncident,
        lastModifiedDateTime: incident.lastModifiedDateTime,
        name: incident.name,
        ownerId: incident.ownerId,
        parentId: incident.parentId,
        severity: incident.severity,
        stakeHoldersLgIds: incident.stakeHoldersLgIds,
        stakeHoldersUserIds: incident.stakeHoldersUserIds,
        status: incident.status,
        x: incident.x,
        y: incident.y,
        z: incident.z
    }

    //Check to see if incident exists
    var project;
    if (!core.projects(incidentid)){
        project = core.projects({_id: incidentid}).data(data).sync();
    }
    else {
        project = core.projects(incidentid);
        //Check to see if it is updated
        var date_old = new Date(project.data('lastModifiedDateTime'));
        var date_new = new Date(incident.lastModifiedDateTime);
        if (date_new > date_old){
            project.data(data).sync();
        }
    }
    //TODO: add IEPS as items to project
    return project;
}

function get_incident(token, incident){
    var incidentid = incident.incidentId.toString();
    console.log('Getting incident',incidentid);
    var options = {
      method: 'get',
      headers: {token: token},
      json: true,
      url: apiurl + 'Incident/'+incidentid+'?jobTitleId=26149'
    }
    request(options,function(err, res, body){
        if (err) {
          inspect(err, 'error posting json')
          return
        }
        if (body.incident){
            var childIncidents = body.incident.childIncidents;
            //Create/Update/Delete incident
            crud_incident(body.incident);

            load_tasks(token,incidentid);

            if (childIncidents){
                childIncidents.forEach(function(incident){
                    var project = crud_incident(incident);
                    load_tasks(token,project.id());
                })
            }
        }
    });

}

function load_incidents(token){
    console.log('Start loading incidents');
    var options = {
      method: 'get',
      headers: {token: token},
      json: true,
      url: apiurl + 'incidentlist?jobTitleId=26149'
    }

    request(options,function(err, res, body){
        if (err) {
          inspect(err, 'error posting json')
          return
        }
        if (body.incidents){
            //Get an array of incident ids from connector
            var activeIncidentArray = body.incidents.map(function(d){
                return d.incidentId;
            });
            //Compare ids to existing list and delete accordingly
            core.projects().filter(function(d){return !d.deleted();}).forEach(function(d){
                if (activeIncidentArray.indexOf(parseInt(d.id())) == -1){
                    console.log('deleting ',d.id());
                    d.deleted(true).sync();
                }
            });
            //Now per incident we start loading the data
            body.incidents.forEach(function(d){
                get_incident(token, d);
            });
        }
    });
}


function load_sw(){
    var options = {
      method: 'post',
      body: {"password": "stef", "username": "stef"},//TODO: Move to configfile
      json: true,
      url: apiurl + 'Login'
    }
    //Start with logging in
    request(options, function (err, res, body) {
      if (err) {
        inspect(err, 'error posting json')
        return
      }
      var headers = res.headers;
      var statusCode = res.statusCode;
      var token = body.token;

      //Continue with loading incidentlist
      load_incidents(token);

    });
}
