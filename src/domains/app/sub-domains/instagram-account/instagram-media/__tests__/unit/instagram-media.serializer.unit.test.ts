import { describe, expect, it } from 'vitest';
import {
  readInstagramMediaProductType,
  readInstagramMediaType,
  readInstagramTimestamp,
  serializeInstagramMediaItem,
  serializeInstagramStory,
} from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.serializer.js';

/**
 * The post and story picker objects (routes-final § 1.C.6, IA16): Instagram's answer mapped key for
 * key — upper-case types lowered, `timestamp` → `published_at`, `children.data` → `children`, a
 * story's `expires_at` 24 hours after it was published.
 */
describe('Instagram media serializers', () => {
  it('shapes a carousel post: types lowered, timestamp as ISO, children flattened', () => {
    const item = serializeInstagramMediaItem({
      id: '18030000000000004',
      caption: 'Three colours, one price — comment SHOP',
      media_type: 'CAROUSEL_ALBUM',
      media_product_type: 'FEED',
      media_url: 'https://cdn.example.com/cover.jpg',
      permalink: 'https://www.instagram.com/p/AcmeCarousel/',
      timestamp: '2026-11-18T12:00:00+0000',
      comments_count: 31,
      like_count: 512,
      children: {
        data: [
          {
            id: '18030000000000005',
            media_type: 'IMAGE',
            media_url: 'https://cdn.example.com/red.jpg',
          },
          { id: '18030000000000006', media_type: 'VIDEO' },
        ],
      },
    });

    expect(item).toEqual({
      instagram_media_id: '18030000000000004',
      caption: 'Three colours, one price — comment SHOP',
      media_type: 'carousel_album',
      media_product_type: 'feed',
      media_url: 'https://cdn.example.com/cover.jpg',
      thumbnail_url: null,
      permalink: 'https://www.instagram.com/p/AcmeCarousel/',
      published_at: '2026-11-18T12:00:00.000Z',
      comments_count: 31,
      like_count: 512,
      children: [
        {
          instagram_media_id: '18030000000000005',
          media_type: 'image',
          media_url: 'https://cdn.example.com/red.jpg',
        },
        { instagram_media_id: '18030000000000006', media_type: 'video', media_url: null },
      ],
    });
  });

  it('shapes a reel without children, and leaves what Instagram omits null', () => {
    const item = serializeInstagramMediaItem({
      id: '18030000000000002',
      media_type: 'VIDEO',
      media_product_type: 'REELS',
      timestamp: '2026-11-19T08:30:00+0000',
    });

    expect(item).toMatchObject({
      instagram_media_id: '18030000000000002',
      caption: null,
      media_type: 'video',
      media_product_type: 'reels',
      media_url: null,
      permalink: null,
      published_at: '2026-11-19T08:30:00.000Z',
      comments_count: null,
      like_count: null,
      children: null,
    });
  });

  it('reads an unknown type, a missing timestamp and empty children as null', () => {
    const item = serializeInstagramMediaItem({
      id: '18030000000000007',
      media_type: 'HOLOGRAM',
      media_product_type: 'BILLBOARD',
      children: { data: [] },
    });

    expect(item.media_type).toBeNull();
    expect(item.media_product_type).toBeNull();
    expect(item.published_at).toBeNull();
    expect(item.children).toBeNull();
  });

  it('shapes a story that ends 24 hours after it was published', () => {
    expect(
      serializeInstagramStory({
        id: '17900000000000002',
        media_type: 'VIDEO',
        media_url: 'https://cdn.example.com/story.mp4',
        thumbnail_url: 'https://cdn.example.com/story.jpg',
        permalink: 'https://www.instagram.com/stories/acme.shop/17900000000000002/',
        timestamp: '2026-11-21T09:40:00+0000',
      }),
    ).toEqual({
      instagram_story_id: '17900000000000002',
      media_type: 'video',
      media_url: 'https://cdn.example.com/story.mp4',
      thumbnail_url: 'https://cdn.example.com/story.jpg',
      permalink: 'https://www.instagram.com/stories/acme.shop/17900000000000002/',
      published_at: '2026-11-21T09:40:00.000Z',
      expires_at: '2026-11-22T09:40:00.000Z',
    });
  });

  it('gives a story without a readable timestamp no end time, and never a carousel type', () => {
    expect(
      serializeInstagramStory({ id: '17900000000000003', media_type: 'CAROUSEL_ALBUM' }),
    ).toMatchObject({ media_type: null, published_at: null, expires_at: null });
  });

  it('reads the value lists and timestamps it maps', () => {
    expect(readInstagramMediaType('IMAGE')).toBe('image');
    expect(readInstagramMediaType(undefined)).toBeNull();
    expect(readInstagramMediaProductType('AD')).toBe('ad');
    expect(readInstagramMediaProductType('STORY')).toBe('story');
    expect(readInstagramTimestamp('2026-11-20T10:00:00+0000')?.toISOString()).toBe(
      '2026-11-20T10:00:00.000Z',
    );
    expect(readInstagramTimestamp('not a time')).toBeNull();
    expect(readInstagramTimestamp(1_700_000_000)).toBeNull();
  });
});
