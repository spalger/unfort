import fs from 'fs';
import chalk from 'chalk';
import MemoryStream from 'memorystream';
import babelCodeFrame from 'babel-code-frame';
import {assert} from './assert';
import {
  createJSModuleDefinition, createRecordDescription, describeError, describeErrorList,
  createRecordContentStream, createRecordSourceMapStream
} from '../utils';

describe('unfort/utils', () => {
  describe('#createJSModuleDefinition', () => {
    it('should produce a module definition for the bootstrap runtime', () => {
      assert.equal(
        createJSModuleDefinition({
          name: 'test_name',
          hash: 'test_hash',
          deps: {testId: 'test_name'},
          code: 'test_code'
        }),
        [
          '__modules.defineModule({name: "test_name", deps: {"testId":"test_name"}, hash: "test_hash", factory: function(module, exports, require, process, global) {',
          'test_code',
          '}});'
        ].join('\n')
      );
    });
  });
  describe('#createRecordDescription', () => {
    it('should accept a record and produce a description that the hot runtime can interpret', () => {
      assert.deepEqual(
        createRecordDescription({
          name: 'test_name',
          data: {
            hash: 'test_hash',
            url: 'test_url',
            isTextFile: 'test_is_text_file'
          }
        }),
        {
          name: 'test_name',
          hash: 'test_hash',
          url: 'test_url',
          isTextFile: 'test_is_text_file'
        }
      );
    });
  });
  describe('#describeError', () => {
    it('should accept an error and produce a textual representation for logging', () => {
      const err = new Error('test');
      assert.equal(
        describeError(err),
        err.stack
      );
    });
    it('should accept an optional file and provide further context', () => {
      const err = new Error('test');
      assert.equal(
        describeError(err, 'test_filename'),
        [
          chalk.red('test_filename') + '\n',
          err.stack
        ].join('\n')
      );
    });
    it('should provide a code frame to further contextualize the error', () => {
      const err = new Error('test');
      err.loc = {
        line: 1,
        column: 1
      };
      assert.equal(
        describeError(err, __filename),
        [
          chalk.red(__filename) + '\n',
          babelCodeFrame(fs.readFileSync(__filename, 'utf8'), 1, 1),
          err.stack
        ].join('\n')
      );
    });
    it('should not override a code frame already attached', () => {
      const err = new Error('test');
      err.codeFrame = 'test code frame';
      assert.equal(
        describeError(err, __filename),
        [
          chalk.red(__filename) + '\n',
          'test code frame',
          err.stack
        ].join('\n')
      );
    });
    it('should silently fail if a file cannot be read for the code frame', () => {
      const err = new Error('test');
      err.loc = {
        line: 1,
        column: 1
      };
      assert.equal(
        describeError(err, '__file that does not exist__'),
        [
          chalk.red('__file that does not exist__') + '\n',
          err.stack
        ].join('\n')
      );
    });
  });
  describe('describeErrorList', () => {
    it('should produce a textual description of a list of errors, such that they can be logged', () => {
      const errors = [
        new Error('test 1'),
        new Error('test 2')
      ];

      assert.equal(
        describeErrorList(errors),
        [
          describeError(errors[0]),
          describeError(errors[1])
        ].join('\n')
      );
    });
    it('should handle graph error objects (which contain an error and extra data), such that they can be logged', () => {
      const err1 = new Error('test 1');
      const err2 = new Error('test 2');
      const errors = [
        err1,
        {
          error: err2,
          node: 'test_filename'
        }
      ];

      assert.equal(
        describeErrorList(errors),
        [
          describeError(err1),
          describeError(err2, 'test_filename')
        ].join('\n')
      );
    });
  });
});