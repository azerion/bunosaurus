module.exports = function asyncLoader(content) {
  const callback = this.async();
  setTimeout(() => callback(null, `async(${content})`), 1);
};
