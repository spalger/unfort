import * as path from 'path';
import {assert} from '../../utils/assert';
import {nodeCoreLibs} from '../node_core_libs';
import {browserResolver} from '../browser_resolve';

describe('dependencies/browser_resolve', () => {
  describe('#browserResolver', () => {
    it('should correctly resolve `browser` dependencies', (done) => {
      browserResolver({dependency: '__resolve_test_case__', basedir: __dirname}, (err, resolved) => {
        assert.isNull(err);
        assert.equal(
          resolved,
          path.join(__dirname, 'node_modules', '__resolve_test_case__', 'browser.js')
        );
        done();
      });
    });
    it('should map to packages that replace node core libraries', (done) => {
      browserResolver({dependency: 'path', basedir: __dirname}, (err, resolved) => {
        assert.isNull(err);
        assert.equal(resolved, nodeCoreLibs.path);
        done();
      });
    });
    it('should provide helpful error messages for failed lookups', (done) => {
      browserResolver({dependency: '__non_existent_package__', basedir: __dirname}, (err) => {
        assert.instanceOf(err, Error);
        assert.include(err.message, '__non_existent_package');
        assert.include(err.message, __dirname);
        done();
      });
    });
  });
});