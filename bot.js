var rest = require('restler');
var Datastore = require('nedb');
var q = require('q');

var sparkConfig = require('./sparkConfig.js');
var twilioConfig = require('./twilioConfig.js');

var textQueue_db = new Datastore({filename: './textQueue.db', autoload:true});
var displayQueue_db = new Datastore({filename: './displayQueue.db', autoload:true});
var displayedTexts_db = new Datastore({filename: './displayedTexts.db', autoload:true});

//how many times it will try to send everything to the spark before giving up
 var sparkErrorThreshhold = 3;

var twiloClient = require('twilio')(twiloConfig.accountSid, twiloConfig.authToken); 

function queueTexts() {
	//todo go back two days
	twiloClient.messages.list({'DateSent>':'2015-05-01'},     
		function(err, data) { 
			if (err !== null){
				console.log(err);
			}
			else {
				data.messages.forEach(function(message) { 
					if (message.direction == 'inbound'){
						console.log(message.sid, message.body, message.date_sent); 

						var isDisplayedPromise = isAlreadyDisplayed(message);
						isDisplayedPromise.done(function(result){
							if(result.toQueue){//text not found! queue it up!
								var queueText = processTextData(result.data);					
								textQueue_db.insert(queueText);
								console.log("queueing ", queueText.message);
							}
						});
					}
				}); 
			}
		}
	);
		
}

function processTextData(textData){
	var queuedMessage = "@" + textData.user.screen_name + " - ";
	
	//If the message begins with the name of who it was a reply to, remove that name from the string
	if (!showBeginningName && (textData.text).indexOf(textData.in_reply_to_screen_name) == 1){
		queuedMessage = queuedMessage + (textData.text).substring(textData.in_reply_to_screen_name.length+2);
	}
	else { //otherwise, just display the text
		queuedMessage = queuedMessage + textData.text;
	}

	var queueText = {
		"id" : textData.id,
		created_at: new Date(textData.created_at),
		message : queuedMessage
	};

	return queueText;
}

function isTextQueued(textData){
	var deferred = q.defer();
	textQueue_db.loadDatabase();
	textQueue_db.findOne({id : textData.sid}, function (err, doc) {
		if (err){ //if theres an error, just let it check next time
			deferred.resolve(true);
		}
		else if (doc === null){ //if nothing was found, return false
			deferred.resolve(false);
		}
		else { // otherwise return true
			deferred.resolve(true);
		}
	});
	
	return deferred.promise;
}

function isDisplayQueued(textData){
	var deferred = q.defer();
	displayQueue_db.loadDatabase();
	displayQueue_db.findOne({id : textData.sid}, function (err, doc) {
		if (err){ //if theres an error, just let it check next time
			deferred.resolve(true);
		}
		else if (doc === null){ //if nothing was found, return false
			deferred.resolve(false);
		}
		else { // otherwise return true
			deferred.resolve(true);
		}
	});
	
	return deferred.promise;

}

function isAlreadyDisplayed(textData){
	var deferred = q.defer();

	var isTextQueuedPromise = isTextQueued(textData);
	isTextQueuedPromise.done(function(isTextQueuedRes){
		if(isTextQueuedRes){
			deferred.resolve({toQueue: false, data:textData});
		}
		else{
			var isDisplayQueuedPromise = isDisplayQueued(textData);
			isDisplayQueuedPromise.done(function(isDisplayQueuedRes){
				if(isDisplayQueuedRes){
					deferred.resolve({toQueue: false, data:textData});
				}
				else{
					displayedTexts_db.loadDatabase();
					displayedTexts_db.findOne({id : textData.sid}, function (err, doc) {
						if (err){ //if theres an error, just let it check next time
							deferred.resolve({toQueue: false, data:textData});
						}
						else if (doc === null){ //value not found, queue up
							deferred.resolve({toQueue: true, data:textData});
						}
						else { //value found, do not queue it up
							deferred.resolve({toQueue: false, data:textData});
						}
					});
				}
			});
		}
	});

	return deferred.promise;
}

 function getLeastRecentText(){
 	var deferred = q.defer();

 	displayQueue_db.findOne({}).sort({ created_at: 1 }).exec(function (err, doc) {
  		deferred.resolve(doc);
	});

 	return deferred.promise;
 }

 function incrementErrorCount(text){
 	displayQueue_db.update({ id: text.id }, { $inc: {errorCount: 1}});
 }

 function displayText(){
 	console.log("looking to display texts");

	displayQueue_db.loadDatabase();
 	displayQueue_db.count({}, function (err, count) {
	  if (count > 0){
		getLeastRecentText().done(function(textOfInterest){
			if (textOfInterest.errorCount && textOfInterest.errorCount >= (sparkErrorThreshhold-1)){
				//too many errors, send to displayed
				displayedTexts_db.insert({id: textOfInterest.id, message: "Error: " +  textOfInterest.message, displayed_at: new Date(), displayed: false, errored: true});
				displayQueue_db.remove({id: textOfInterest.id}, {multi: true});
			}
			else {
				sendMessage(1,{message: "BEGIN"}).done(function(){
					var promiseChain = q.fcall(function(){});
					var formatMessage = textOfInterest.message;

					formatMessage = formatMessage.replace(/“/g, '"');
					formatMessage = formatMessage.replace(/”/g, '"');
					formatMessage = formatMessage.replace(/‘/g, '\'');
					formatMessage = formatMessage.replace(/’/g, '\'');

					formatMessage = formatMessage.replace(/&amp;/g, '%26');

					var msgsNeeded = Math.ceil(formatMessage.length/61);

					var addToChain = function (i){
						var message = {id: textOfInterest.id};
						if (i == (msgsNeeded - 1)){
							message.message = formatMessage.substring(61*i);
						}
						else {
							message.message = formatMessage.substring(61*i, 61 * (i+1));
						}

						var promiseLink = function(){
							var deferred = q.defer();
							sendMessage(0, message).done(function(){deferred.resolve();}, function(){deferred.reject();});
							return deferred.promise;
						};

						promiseChain = promiseChain.then(promiseLink);
					}

					for (var i = 0; i < msgsNeeded; i++) {
						addToChain(i);
					}

					promiseChain.done(function(){
						sendMessage(1,{message:"END", id: textOfInterest.id, created_at: textOfInterest.created_at}, formatMessage)
							.done(function(){}, function(){incrementErrorCount(textOfInterest);});
					}, function(){
						incrementErrorCount(textOfInterest);
					});
				}, function(){ //BEGIN errored out
					incrementErrorCount(textOfInterest);
				});
			}
		});
	  }

	});
}

function sendMessage(adminFlag, messageData, rootMsg){
	var deferred = q.defer();
	rest.post('https://api.spark.io/v1/devices/' + sparkConfig.deviceID + '/buildString', {
		data: { 'access_token': sparkConfig.accessToken,
		'args': adminFlag + "," + messageData.message }
	}).on('complete', function(data, response) {
		//sometimes the spark API returns the html for the error page instead of the standard array
		if ((data.ok !== undefined && !(data.ok)) || (typeof data == "string" && data.substring(0, 6) == "<html>")){
			console.log("Error: " + data.error + " for ", adminFlag, messageData.message, " Text will be requeued.");
			deferred.reject(data.error);
		}
		else {
			console.log("msg sent : ", adminFlag, messageData.message);	
			if (adminFlag == 1 && messageData.message == "END"){
				//only put the id in the displayed db if sending to the spark doesn't fail
				displayedTexts_db.insert({id: messageData.id, message: rootMsg, displayed_at: new Date(), displayed: true});
				displayQueue_db.remove({id: messageData.id}, {multi: true});
				console.log("display done");
			}
			deferred.resolve();
		}
	});

	return deferred.promise;
}

 queueTexts(); 
 
 //find texts every three minutes
 setInterval(queueTexts, 2 * 1000 * 60);

 //display a text every minute
 setInterval(displayText, 1000 * 30);

// //Make this a process to go off every so often if this program ends up staying online longterm
// function dbCleanup(){
// 	var now = new Date();
// 	displayed_db.createReadStream()
// 	.on('data', function (data) {
// 		var tweetDate = new Date(data.value);
// 		if (now - tweetDate > 1000*60*60*24*dbCleanupDays){
// 			displayed_db.del(data.key);
// 		}
// 	});
// }

// dbCleanup();