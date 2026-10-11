module.exports = function emitLoader(content) {
  this.emitFile('assets/out.txt', 'content');
  return content;
};
