function findByCommand(source, command) {
    return source.filter(function( obj ) {
        // coerce both obj.id and id to numbers
        // for val & type comparison
        return +obj.command === +command;
    })[ 0 ];
}
function isNotificationRequired(notificationPatterns, pipelineStatus) {
  return new RegExp(notificationPatterns.join('|')).test(pipelineStatus);
}

module.exports = {
  isNotificationRequired: isNotificationRequired,
  findByCommand: findByCommand
}
