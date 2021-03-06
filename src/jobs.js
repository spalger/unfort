import fs from 'fs';
import path from 'path';
import Murmur from 'imurmurhash';
import * as mimeTypes from 'mime-types';
import * as babel from 'babel-core';
import * as babylon from 'babylon';
import postcss from 'postcss';
import browserifyBuiltins from 'browserify/lib/builtins';
import _browserResolve from 'browser-resolve';
import promisify from 'promisify-node';
import {startsWith} from 'lodash/string';
import {includes} from 'lodash/collection';
import {zipObject} from 'lodash/array';
import {assign} from 'lodash/object';
import {isNull} from 'lodash/lang';
import babylonAstDependencies from 'babylon-ast-dependencies';
import postcssAstDependencies from 'postcss-ast-dependencies';
import babelGenerator from 'babel-generator';
import {createJSModuleDefinition, JS_MODULE_SOURCE_MAP_LINE_OFFSET} from './utils';

const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);
const browserResolve = promisify(_browserResolve);

export function createJobs({getState}={}) {
  return {
    ready(ref, store) {
      // All the jobs that must be completed before
      // the record is emitted
      return Promise.all([
        ref.name,
        store.hash(ref),
        store.content(ref),
        store.moduleDefinition(ref),
        store.url(ref),
        store.sourceMapAnnotation(ref),
        store.hashedFilename(ref),
        store.isTextFile(ref),
        store.mimeType(ref),
        store.fileDependencies(ref)
      ]);
    },
    basename(ref) {
      return Promise.resolve(
        path.basename(ref.name, path.extname(ref.name))
      );
    },
    ext(ref) {
      return Promise.resolve(path.extname(ref.name));
    },
    isTextFile(ref, store) {
      return store.ext(ref).then(ext => {
        return (
          ext === '.js' ||
          ext === '.css' ||
          ext === '.json'
        );
      });
    },
    mimeType(ref, store) {
      return store.ext(ref)
        .then(ext => mimeTypes.lookup(ext) || null);
    },
    readText(ref) {
      return readFile(ref.name, 'utf8');
    },
    stat(ref) {
      return stat(ref.name);
    },
    mtime(ref, store) {
      return store.stat(ref)
        .then(stat => {
          return stat.mtime.getTime();
        });
    },
    hashText(ref, store) {
      return store.readText(ref)
        .then(text => {
          const hash = new Murmur(text).result();
          return hash.toString();
        });
    },
    hash(ref, store) {
      return store.isTextFile(ref)
        .then(isTextFile => {
          if (isTextFile) {
            return store.hashText(ref);
          } else {
            return store.mtime(ref);
          }
        })
        // We coerce everything to a string for consistency
        .then(hash => hash.toString());
    },
    hashedFilename(ref, store) {
      return Promise.all([
        store.basename(ref),
        store.hash(ref),
        store.ext(ref)
      ])
        .then(([basename, hash, ext]) => {
          return `${basename}-${hash}${ext}`;
        });
    },
    hashedName(ref, store) {
      return store.hashedFilename(ref)
        .then(hashedFilename => {
          return path.join(path.dirname(ref.name), hashedFilename);
        });
    },
    cache() {
      return Promise.resolve(getState().jobCache);
    },
    cacheKey(ref, store) {
      return store.isTextFile(ref)
        .then(isTextFile => {
          const key = [
            ref.name,
            store.mtime(ref)
          ];

          if (isTextFile) {
            key.push(store.hash(ref));
          }

          return Promise.all(key);
        });
    },
    readCache(ref, store) {
      return Promise.all([
        store.cache(ref),
        store.cacheKey(ref)
      ])
        .then(([cache, key]) => cache.get(key))
        .then(data => {
          if (isNull(data)) {
            return {};
          }
          return data;
        });
    },
    writeCache(ref, store) {
      return Promise.all([
        store.cache(ref),
        store.cacheKey(ref),
        store.readCache(ref)
      ])
        .then(([cache, key, cacheData]) => {
          return cache.set(key, cacheData);
        });
    },
    url(ref, store) {
      return store.isTextFile(ref)
        .then(isTextFile => {
          if (isTextFile) {
            return store.hashedName(ref);
          } else {
            return ref.name;
          }
        })
        .then(name => {
          const {sourceRoot, rootUrl} = getState();

          // Try to produce a more readable url, but fallback to an absolute
          // path if necessary. The fallback is necessary if the record is
          // being pulled in from outside the source root, eg: by a symbolic
          // link
          let relPath;
          if (startsWith(name, sourceRoot)) {
            relPath = path.relative(sourceRoot, name);
          } else {
            relPath = name;
          }

          return rootUrl + relPath.split(path.ext).join('/');
        });
    },
    /**
     * A url to the original content of the record
     */
    sourceUrl(ref, store) {
      return store.hash(ref)
        .then(hash => {
          // We append the hash to get around browser caching of
          // source maps
          return 'file://' + ref.name + '?' + hash;
        });
    },
    sourceMapAnnotation(ref, store) {
      return Promise.all([
        store.ext(ref),
        store.sourceMap(ref)
      ]).then(([ext, sourceMap]) => {
        if (
          !sourceMap ||
          !includes(['.css', '.js', '.json'], ext)
        ) {
          return null;
        }

        const base64SourceMap = (new Buffer(sourceMap)).toString('base64');
        const body = 'sourceMappingURL=data:application/json;charset=utf-8;base64,' + base64SourceMap;

        if (ext === '.css') {
          return `\n/*# ${body} */`;
        } else {
          return '\n//# ' + body;
        }
      });
    },
    postcssPlugins() {
      return Promise.resolve([]);
    },
    postcssTransformOptions(ref, store) {
      return Promise.all([
        store.url(ref),
        store.sourceUrl(ref)
      ])
        .then(([url, sourceUrl]) => {
          return {
            from: sourceUrl,
            to: url,
            // Generate a source map, but keep it separate from the code
            map: {
              inline: false,
              annotation: false
            }
          };
        });
    },
    postcssTransform(ref, store) {
      return Promise.all([
        store.readText(ref),
        store.postcssPlugins(ref),
        store.postcssTransformOptions(ref)
      ]).then(([text, plugins, options]) => {

        // Finds any `@import ...` and `url(...)` identifiers and
        // annotates the result object
        const analyzeDependencies = postcss.plugin('unfort-analyze-dependencies', () => {
          return (root, result) => {
            result.unfortDependencies = postcssAstDependencies(root);
          };
        });

        // As we serve the files with different names, we need to remove
        // the `@import ...` rules
        const removeImports = postcss.plugin('unfort-remove-imports', () => {
          return root => {
            root.walkAtRules('import', rule => rule.remove());
          };
        });

        plugins = plugins.concat([
          analyzeDependencies,
          removeImports
        ]);

        return postcss(plugins).process(text, options);
      });
    },
    babelTransformOptions(ref, store) {
      return Promise.all([
        store.url(ref),
        store.sourceUrl(ref)
      ])
        .then(([url, sourceUrl]) => {
          return {
            filename: ref.name,
            sourceType: 'module',
            sourceMaps: true,
            sourceMapTarget: url,
            sourceFileName: sourceUrl
          };
        });
    },
    babelTransform(ref, store) {
      return Promise.all([
        store.readText(ref),
        store.babelTransformOptions(ref)
      ]).then(([text, options]) => {
        return babel.transform(text, options);
      });
    },
    babelGeneratorOptions(ref, store) {
      return Promise.all([
        store.url(ref),
        store.sourceUrl(ref)
      ])
        .then(([url, sourceUrl]) => {
          // We want to preserve the compression applied to vendor assets
          const shouldMinify = startsWith(ref.name, getState().vendorRoot);

          return {
            sourceMaps: true,
            sourceMapTarget: url,
            sourceFileName: sourceUrl,
            minified: shouldMinify
          };
        });
    },
    babelGenerator(ref, store) {
      return Promise.all([
        store.readText(ref),
        store.babylonAst(ref),
        store.babelGeneratorOptions(ref)
      ]).then(([text, ast, options]) => {
        return babelGenerator(ast, options, text);
      });
    },
    shouldBabelTransform(ref) {
      const {rootNodeModules, vendorRoot} = getState();

      return Promise.resolve(
        !startsWith(ref.name, rootNodeModules) &&
        !startsWith(ref.name, vendorRoot)
      );
    },
    babelFile(ref, store) {
      return store.shouldBabelTransform(ref)
        .then(shouldBabelTransform => {
          if (shouldBabelTransform) {
            return store.babelTransform(ref);
          } else {
            return store.babelGenerator(ref);
          }
        });
    },
    babelAst(ref, store) {
      return store.babelTransform(ref)
        .then(file => file.ast);
    },
    babylonAst(ref, store) {
      return store.readText(ref)
        .then(text => {
          return babylon.parse(text, {
            sourceType: 'script'
          });
        });
    },
    ast(ref, store) {
      return store.ext(ref)
        .then(ext => {
          if (ext === '.js') {
            return store.shouldBabelTransform(ref)
              .then(shouldBabelTransform => {
                if (shouldBabelTransform) {
                  return store.babelAst(ref);
                } else {
                  return store.babylonAst(ref);
                }
              });
          }

          // Note: we reject the `ast` job for .css files as we handle
          // it during the initial traversal and transformation in the
          // `postcssTransform` job
          throw new Error(`Unknown extension "${ext}", cannot parse "${ref.name}"`);
        });
    },
    analyzeDependencies(ref, store) {
      return store.ext(ref)
        .then(ext => {
          if (ext === '.css') {
            return store.postcssTransform(ref)
              .then(result => {
                return result.unfortDependencies;
              });
          }

          if (ext === '.js') {
            return store.ast(ref)
              .then(ast => babylonAstDependencies(ast));
          }

          return [];
        });
    },
    dependencyIdentifiers(ref, store) {
      return store.readCache(ref)
        .then(cachedData => {
          if (cachedData.dependencyIdentifiers) {
            return cachedData.dependencyIdentifiers;
          }

          return store.analyzeDependencies(ref)
            .then(deps => deps.map(dep => dep.source))
            // Remove any parts of the identifier that we wont be able to
            // map to the file system
            .then(ids => ids.map(id => {
              // Webpack loaders
              const bangStart = id.indexOf('!');
              if (bangStart !== -1) {
                id = id.slice(0, bangStart);
              }

              // Url params
              const paramStart = id.indexOf('?');
              if (paramStart !== -1) {
                id = id.slice(0, paramStart);
              }

              // Url hashes
              const hashStart = id.indexOf('#');
              if (hashStart !== -1) {
                id = id.slice(0, hashStart);
              }

              return id;
            }))
            .then(ids => cachedData.dependencyIdentifiers = ids);
        });
    },
    pathDependencyIdentifiers(ref, store) {
      return store.dependencyIdentifiers(ref)
        .then(ids => ids.filter(id => id[0] === '.' || path.isAbsolute(id)));
    },
    packageDependencyIdentifiers(ref, store) {
      return store.dependencyIdentifiers(ref)
        .then(ids => ids.filter(id => id[0] !== '.' && !path.isAbsolute(id)));
    },
    resolver(ref, store) {
      return store.resolverOptions(ref)
        .then(options => {
          // We use `browser-resolve` to resolve ids as it picks up browser-specific
          // entry points for packages
          return id => browserResolve(id, options);
        });
    },
    resolverOptions(ref) {
      return Promise.resolve({
        // The directory that the resolver starts in when looking for a file
        // to matches an identifier
        basedir: path.dirname(ref.name),
        // The extensions that the resolver looks for considering identifiers
        // without an extension
        extensions: ['.js', '.json'],
        // The node core modules that should be shimmed for browser environments.
        // We use browserify's as they tend to upgrade them more often. Webpack's
        // `node-libs-browser` is another alternative
        modules: browserifyBuiltins
      });
    },
    /**
     * If a dependency identifier is relative (./ ../) or absolute (/), there are
     * edge-cases where caching the resolved path may produce the wrong result.
     * For example: an identifier "./foo" may resolve to either a "./foo.js" or
     * or "./foo/index.js". Detecting these cases is problematic, so we avoid the
     * problem by ensuring that the resolver always inspects the file system for
     * path-based identifiers originating from files that we expect to change
     * frequently.
     *
     * The one exception is files that live in node_modules, we aggressively cache
     * these as we assume they are static. This enables us to avoid some costly IO
     * overhead when possible
     */
    shouldCacheResolvedPathDependencies(ref) {
      return Promise.resolve(
        startsWith(ref.name, getState().rootNodeModules)
      );
    },
    /**
     * If a dependency identifier refers to a package (eg: is not a path-based
     * identifier), we can cache the resolved path and leave higher levels to
     * perform cache invalidation
     */
    shouldCacheResolvedPackageDependencies() {
      return Promise.resolve(true);
    },
    resolvePathDependencies(ref, store) {
      return Promise.all([
        store.readCache(ref),
        store.shouldCacheResolvedPathDependencies(ref)
      ])
        .then(([cachedData, shouldCache]) => {
          if (shouldCache && cachedData.resolvePathDependencies) {
            return cachedData.resolvePathDependencies;
          }

          return store.pathDependencyIdentifiers(ref)
            .then(ids => store.resolver(ref)
              .then(resolver => Promise.all(ids.map(id => resolver(id))))
              .then(resolved => zipObject(ids, resolved))
            )
            .then(deps => cachedData.resolvePathDependencies = deps);
        });
    },
    resolvePackageDependencies(ref, store) {
      return Promise.all([
        store.readCache(ref),
        store.shouldCacheResolvedPackageDependencies(ref)
      ])
      .then(([cachedData, shouldCache]) => {
        if (shouldCache && cachedData.resolvePackageDependencies) {
          return cachedData.resolvePackageDependencies;
        }

        return store.packageDependencyIdentifiers(ref)
          .then(ids => store.resolver(ref)
            .then(resolver => Promise.all(ids.map(id => resolver(id))))
            .then(resolved => zipObject(ids, resolved))
          )
          .then(deps => cachedData.resolvePackageDependencies = deps);
      });
    },
    resolvedDependencies(ref, store) {
      return Promise.all([
        store.resolvePackageDependencies(ref),
        store.resolvePathDependencies(ref)
      ])
        .then(([pathDeps, packageDeps]) => {
          return assign({}, pathDeps, packageDeps);
        });
    },
    code(ref, store) {
      return store.isTextFile(ref)
        .then(isTextFile => {
          if (!isTextFile) {
            return null;
          }

          return Promise.all([
            store.ext(ref),
            store.readCache(ref)
          ])
            .then(([ext, cachedData]) => {
              if (cachedData.code) {
                return cachedData.code;
              }

              if (ext === '.css') {
                return store.postcssTransform(ref)
                  .then(result => cachedData.code = result.css);
              }

              if (ext === '.js') {
                const state = getState();
                // Serve up the runtimes without any transformation
                if (
                  ref.name === state.bootstrapRuntime ||
                  ref.name === state.hotRuntime
                ) {
                  return store.readText(ref);
                }

                return store.babelFile(ref)
                  .then(file => cachedData.code = file.code);
              }

              if (ext === '.json') {
                return store.readText(ref);
              }

              return Promise.reject(
                `Unknown text file extension: ${ext}. Cannot generate code for file: ${ref.name}`
              );
            });
        });
    },
    /**
     * For JS and JSON records, we can inject the record's code. For all other
     * types, we inject a url to their location
     */
    moduleContents(ref, store) {
      return store.ext(ref)
        .then(ext => {
          if (ext === '.js' || ext === '.json') {
            return store.code(ref);
          } else {
            return store.url(ref)
              .then(url => JSON.stringify(url));
          }
        });
    },
    /**
     * Indicates if the record requires a shim module to be defined. These shim
     * modules are used so that the runtime can interact with a representation
     * of non-JS records
     */
    shouldShimModuleDefinition(ref, store) {
      return store.ext(ref)
        .then(ext => ext !== '.js');
    },
    /**
     * Generates the module code for a record. This is primarily of use to
     * create shim modules for non-js records
     */
    moduleCode(ref, store) {
      return Promise.all([
        store.shouldShimModuleDefinition(ref),
        store.moduleContents(ref)
      ])
        .then(([shouldShimModuleDefinition, moduleContents]) => {
          if (!shouldShimModuleDefinition) {
            return moduleContents;
          }

          // We fake babel's ES => commonjs shim so that the hot runtime knows
          // that `module.exports` will never be a function and hence a proxy
          // object can be used
          return [
            'Object.defineProperty(exports, "__esModule", {',
            '  value: true',
            '});',
            `exports["default"] = ${moduleContents};`,
            'if (module.hot) {',
            '  module.hot.accept();',
            '}'
          ].join('\n');
        });
    },
    /**
     * Create the module definition that we use to inject a record into
     * the runtime
     */
    moduleDefinition(ref, store) {
      // The bootstrap is the one file that we need to ensure is pushed
      // to the client without any shims or wrappers
      if (ref.name === getState().bootstrapRuntime) {
        return Promise.resolve(null);
      }

      return Promise.all([
        store.resolvedDependencies(ref),
        store.hash(ref),
        store.moduleCode(ref)
      ])
        .then(([resolvedDependencies, hash, moduleCode]) => {
          return createJSModuleDefinition({
            name: ref.name,
            deps: resolvedDependencies,
            hash,
            code: moduleCode
          });
        });
    },
    /**
     * Generates the executable content of a record.
     * For js and json records, this is the module definition.
     * For css, this is the stylesheet.
     */
    content(ref, store) {
      return Promise.all([
        store.isTextFile(ref),
        store.ext(ref)
      ])
      .then(([isTextFile, ext]) => {
        if (!isTextFile) {
          return null;
        }

        if (
          ref.name === getState().bootstrapRuntime ||
          ext === '.css'
        ) {
          return store.code(ref);
        }

        if (ext === '.js' || ext === '.json') {
          return store.moduleDefinition(ref);
        }

        return Promise.reject(
          `Unknown text file extension: ${ext}. Cannot generate content for file: ${ref.name}`
        );
      });
    },
    /**
     * Generates a textual representation of a record's source map
     */
    sourceMap(ref, store) {
      return store.isTextFile(ref)
        .then(isTextFile => {
          if (!isTextFile) {
            return null;
          }

          return store.readCache(ref)
            .then(cachedData => {
              if (cachedData.sourceMap) {
                return cachedData.sourceMap;
              }

              return store.ext(ref)
                .then(ext => {
                  if (ext === '.css') {
                    return store.postcssTransform(ref)
                      .then(result => cachedData.sourceMap = result.map.toString());
                  }

                  if (ext === '.js') {
                    return store.babelFile(ref)
                      .then(file => {
                        // Offset each line in the source map to reflect the call to
                        // the module runtime
                        file.map.mappings = JS_MODULE_SOURCE_MAP_LINE_OFFSET + file.map.mappings;

                        return cachedData.sourceMap = JSON.stringify(file.map);
                      });
                  }

                  if (ext === '.json') {
                    return null;
                  }

                  return Promise.reject(
                    `Unknown text file extension: ${ext}. Cannot generate source map for file: ${ref.name}`
                  );
                });
            });
        });
    },
    /**
     * If any other files were used to generate this record, this should
     * this should return an array of paths to those files. This enables
     * the file watchers to invalidate a record when its dependencies
     * change.
     *
     * An example use-case would be compiling a CSS file with LESS or
     * SASS. As those tools will bundle multiple files into a single file,
     * you should return an array of the bundled files
     */
    fileDependencies() {
      return Promise.resolve([]);
    }
  };
}
