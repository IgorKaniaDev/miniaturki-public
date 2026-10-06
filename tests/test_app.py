import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from unittest.mock import patch
from io import BytesIO
import uuid
import zipfile
from PIL import Image, ImageDraw
import app


def fixture_image():
    im = Image.new('RGB', (200, 300), 'white')
    ImageDraw.Draw(im).rectangle((40, 30, 160, 270), fill='#345678')
    result = BytesIO()
    im.save(result, 'PNG')
    return result.getvalue()


class StudioTests(unittest.TestCase):
    def test_import_originals_icon_and_cdata(self):
        xml = b'''<offer xmlns:x="urn:test"><products><product id="12"><description><name><![CDATA[Lee & Co]]></name></description><images><large><image url="https://example.com/small"/></large><x:originals><x:image url="https://example.com/full"/></x:originals><icons><icon url="https://example.com/icon" x:url_originals="https://example.com/icon-full"/></icons></images></product></products></offer>'''
        p = app.parse_catalog(xml)['12']
        self.assertEqual(p['name'], 'Lee & Co')
        self.assertEqual(p['images'], ['https://example.com/full', 'https://example.com/icon-full'])
        with self.assertRaises(ValueError):
            app.parse_catalog(b'<!DOCTYPE a><offer/>')

    def test_webp_size_transparency_and_two_images(self):
        with patch.object(app, 'fetch_image', return_value=fixture_image()):
            im = Image.open(BytesIO(app.compose(['a', 'b'])))
        self.assertEqual(im.format, 'WEBP')
        self.assertEqual(im.size, (2560, 2560))
        self.assertEqual(im.getpixel((0, 0))[3], 0)
        self.assertEqual(im.getpixel((640, 1280))[3], 255)
        self.assertEqual(im.getpixel((1920, 1280))[3], 255)
        prepared = app.prepare_image(fixture_image(), True)
        self.assertEqual(prepared.size, (121, 241))
        self.assertEqual(app.prepare_image(fixture_image(), False).size, (200, 300))

    def test_two_frames_touch_at_center_like_reference(self):
        with patch.object(app, 'fetch_image', return_value=fixture_image()):
            im = Image.open(BytesIO(app.compose(['a', 'b'], False))).convert('RGBA')
        self.assertEqual(im.getpixel((1279, 1280))[3], 255)
        self.assertEqual(im.getpixel((1280, 1280))[3], 255)
        self.assertEqual(im.getpixel((114, 1280))[3], 0)
        self.assertEqual(im.getpixel((2445, 1280))[3], 0)

    def test_single_image_is_centered_and_can_be_repositioned(self):
        with patch.object(app, 'fetch_image', return_value=fixture_image()):
            centered = Image.open(BytesIO(app.compose(['a'], False))).convert('RGBA')
            shifted = Image.open(BytesIO(app.compose(['a'], False, frames=[{'x': 1, 'y': .5, 'zoom': 1}]))).convert('RGBA')
        self.assertEqual(centered.size, (2560, 2560))
        self.assertEqual(centered.getpixel((1280, 1280))[3], 255)
        self.assertEqual(centered.getpixel((0, 1280))[3], 0)
        self.assertNotEqual(centered.getpixel((600, 1280)), shifted.getpixel((600, 1280)))

    def test_batch_continues_after_error_and_zip_names(self):
        tmp = app.ROOT / '.cache' / ('test-' + uuid.uuid4().hex)
        with patch.object(app, 'OUTPUT', tmp):
            app.JOBS['test'] = {'products': {}, 'finished': 0, 'status': 'running'}
            with patch.object(app, 'compose', side_effect=[ValueError('Bad image'), b'webp']):
                app.run_job('test', [('10', ['a','b'], True, [{}, {}]), ('11', ['a','b'], False, [{}, {}])])
            job = app.JOBS.pop('test')
            self.assertEqual(job['status'], 'done', job.get('message'))
            self.assertEqual(job['finished'], 2)
            self.assertEqual(job['products']['10']['status'], 'error')
            with zipfile.ZipFile(Path(tmp) / 'test' / 'miniaturki.zip') as z:
                self.assertEqual(z.namelist(), ['11.webp'])
            for path in (tmp / 'test').iterdir():
                path.unlink()
            (tmp / 'test').rmdir()
            tmp.rmdir()

    def test_preview_matches_downscaled_export(self):
        from PIL import ImageChops
        for remove_bg in (True, False):
            for urls, frames in ((['a', 'b'], [{'x': .8, 'y': .2, 'zoom': 2}, {'x': .5, 'y': .5, 'zoom': 1}]),
                                 (['a'], [{'x': .7, 'y': .5, 'zoom': 1}])):
                with self.subTest(remove_bg=remove_bg, count=len(urls)):
                    with patch.object(app, 'fetch_image', return_value=fixture_image()):
                        exported = Image.open(BytesIO(app.compose(urls, remove_bg, frames=frames))).convert('RGBA')
                        preview = Image.open(BytesIO(app.compose(urls, remove_bg, 768, frames))).convert('RGBA')
                    exported.thumbnail((768, 768), Image.Resampling.LANCZOS)
                    self.assertEqual(preview.size, (768, 768))
                    # Transparent RGB has no visible meaning; compare premultiplied pixels.
                    difference = ImageChops.difference(exported.convert('RGBa'), preview.convert('RGBa'))
                    self.assertTrue(all(channel.getbbox() is None for channel in difference.split()))

    def test_crop_position_changes_only_image_inside_its_cell(self):
        source = Image.new('RGB', (200, 200), '#cc2333')
        ImageDraw.Draw(source).rectangle((100, 0, 199, 199), fill='#2233cc')
        data = BytesIO(); source.save(data, 'PNG')
        left = [{'x': 0, 'y': .5, 'zoom': 3}, {}]
        right = [{'x': 1, 'y': .5, 'zoom': 3}, {}]
        with patch.object(app, 'fetch_image', return_value=data.getvalue()):
            a = Image.open(BytesIO(app.compose(['a', 'b'], False, frames=left))).convert('RGBA')
            b = Image.open(BytesIO(app.compose(['a', 'b'], False, frames=right))).convert('RGBA')
        self.assertNotEqual(a.getpixel((680, 1280)), b.getpixel((680, 1280)))
        for point in ((1920, 1280), (1500, 500), (2300, 2000)):
            self.assertEqual(a.getpixel(point), b.getpixel(point))
        self.assertGreater(a.getpixel((1280, 1280))[3], 0)

    def test_individual_background_settings_and_legacy_default(self):
        app.CATALOGS['settings'] = {pid: {'images': ['a', 'b']} for pid in ('1', '2')}
        self.addCleanup(app.CATALOGS.pop, 'settings')
        body = {'catalog': 'settings', 'removeBg': False, 'items': [
            {'id': '1', 'images': [1, 0], 'removeBg': True},
            {'id': '2', 'images': [0, 1]}]}
        self.assertEqual(app.resolve_items(body), [('1', ['b', 'a'], True, [{}, {}]), ('2', ['a', 'b'], False, [{}, {}])])
        del body['removeBg']
        self.assertTrue(app.resolve_items(body)[1][2])
        for invalid in ('false', None, 0, []):
            body['items'][0]['removeBg'] = invalid
            with self.assertRaises(ValueError):
                app.resolve_items(body)

    def test_single_and_double_items_can_share_a_batch(self):
        from tempfile import TemporaryDirectory
        app.CATALOGS['mixed'] = {'1': {'images': ['a']}, '2': {'images': ['b', 'c']}}
        self.addCleanup(app.CATALOGS.pop, 'mixed')
        body = {'catalog': 'mixed', 'items': [
            {'id': '1', 'mode': 'single', 'images': [0], 'frames': [{'x': .7, 'y': .5, 'zoom': 1}]},
            {'id': '2', 'mode': 'double', 'images': [1, 0], 'frames': [{}, {}]}]}
        resolved = app.resolve_items(body)
        self.assertEqual(resolved[0], ('1', ['a'], True, [{'x': .7, 'y': .5, 'zoom': 1}]))
        self.assertEqual(resolved[1], ('2', ['c', 'b'], True, [{}, {}]))
        with TemporaryDirectory(dir=app.ROOT) as directory:
            with patch.object(app, 'OUTPUT', Path(directory)), patch.object(app, 'fetch_image', return_value=fixture_image()):
                app.JOBS['mixed-job'] = {'products': {}, 'finished': 0, 'status': 'running'}
                self.addCleanup(app.JOBS.pop, 'mixed-job')
                app.run_job('mixed-job', resolved)
                self.assertEqual(app.JOBS['mixed-job']['status'], 'done')
                with zipfile.ZipFile(Path(directory) / 'mixed-job' / 'miniaturki.zip') as archive:
                    self.assertEqual(sorted(archive.namelist()), ['1.webp', '2.webp'])
                    with Image.open(BytesIO(archive.read('1.webp'))) as single:
                        self.assertEqual(single.size, (2560, 2560))
                        self.assertGreater(single.getpixel((1280, 1280))[3], 0)
        for mode, images in (('single', [0, 1]), ('double', [0]), ('wrong', [0])):
            body['items'][0].update(mode=mode, images=images)
            with self.assertRaises(ValueError):
                app.resolve_items(body)

    def test_batch_uses_each_products_background_setting(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory(dir=app.ROOT) as directory:
            with patch.object(app, 'OUTPUT', Path(directory)):
                app.JOBS['settings-job'] = {'products': {}, 'finished': 0, 'status': 'running'}
                self.addCleanup(app.JOBS.pop, 'settings-job')
                with patch.object(app, 'compose', return_value=b'webp') as compose:
                    app.run_job('settings-job', [('1', ['a', 'b'], True, [{}, {}]), ('2', ['b', 'a'], False, [{}, {}])])
                self.assertEqual([call.args for call in compose.call_args_list], [(['a', 'b'], True), (['b', 'a'], False)])
                self.assertEqual(app.JOBS['settings-job']['status'], 'done')

    def test_invalid_selection(self):
        app.CATALOGS['test'] = {'1': {'images': ['a','b']}}
        try:
            for picks in ([0,0], [-1,1], [0,2], [0]):
                with self.assertRaises(ValueError):
                    app.resolve_items({'catalog':'test','items':[{'id':'1','images':picks}]})
            for frames in ([{}], [{'x': -1}, {}], [{'zoom': '2'}, {}], [{'y': None}, {}]):
                with self.assertRaises(ValueError):
                    app.resolve_items({'catalog':'test','items':[{'id':'1','images':[0,1],'frames':frames}]})
        finally:
            del app.CATALOGS['test']


if __name__ == '__main__':
    unittest.main()
