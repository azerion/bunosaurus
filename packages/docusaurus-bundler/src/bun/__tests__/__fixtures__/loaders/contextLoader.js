module.exports = function contextLoader() {
  return JSON.stringify({
    compilerName: this._compiler.name,
    resourcePath: this.resourcePath,
    resourceQuery: this.resourceQuery,
    options: this.getOptions(),
  });
};
