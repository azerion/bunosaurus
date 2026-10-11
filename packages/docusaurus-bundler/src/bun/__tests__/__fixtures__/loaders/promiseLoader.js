module.exports = async function promiseLoader(content) {
  return `${content}${this.getOptions().suffix}`;
};
