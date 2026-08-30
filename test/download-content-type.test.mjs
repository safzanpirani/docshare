import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APK_CONTENT_TYPE,
  contentTypeForDownload,
} from '../src/download-content-type.ts'

test('Android packages use the platform package MIME type', () => {
  assert.equal(contentTypeForDownload('app.apk', 'application/zip'), APK_CONTENT_TYPE)
  assert.equal(contentTypeForDownload('APP.APK', 'application/octet-stream'), APK_CONTENT_TYPE)
})

test('other downloads retain their stored MIME type', () => {
  assert.equal(contentTypeForDownload('archive.zip', 'application/zip'), 'application/zip')
  assert.equal(contentTypeForDownload('notes.apk.txt', 'text/plain'), 'text/plain')
})
