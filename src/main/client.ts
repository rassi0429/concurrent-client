import { Api } from './api'

import { Socket } from './socket'
import { Timeline } from './timeline'
import { Subscription } from './subscription'

import { 
    Message as CoreMessage,
    Association as CoreAssociation,
    Entity as CoreEntity,
    Stream as CoreStream,
    Character as CoreCharacter,
    CCID,
    FQDN,
    MessageID,
    AssociationID,
    CollectionItemID,
    StreamID,
    SignedObject,
    Certificate,
    ProfileOverride
} from "../model/core";

import { Schemas, Schema } from "../schemas";
import { Like } from "../schemas/like";
import { Userstreams } from "../schemas/userstreams";
import { Profile } from "../schemas/profile";
import { EmojiAssociation } from "../schemas/emojiAssociation";
import { ReplyMessage } from "../schemas/replyMessage";
import { ReplyAssociation } from "../schemas/replyAssociation";
import { RerouteMessage } from "../schemas/rerouteMessage";
import { RerouteAssociation } from "../schemas/rerouteAssociation";
import { SimpleNote } from '../schemas/simpleNote'
import { Commonstream } from '../schemas/commonstream'
import { UserAck } from '../schemas/userAck'
import { UserAckCollection } from '../schemas/userAckCollection'

import { CommputeCCID, KeyPair, LoadKey } from "../util/crypto";

export class Client {
    api: Api
    ccid: CCID
    host: FQDN
    keyPair: KeyPair;
    socket?: Socket

    user: User | null = null

    constructor(privatekey: string, host: FQDN, client?: string) {
        const keyPair = LoadKey(privatekey)
        if (!keyPair) throw new Error('invalid private key')
        this.keyPair = keyPair
        this.ccid = CommputeCCID(keyPair.publickey)
        this.host = host
        this.api = new Api({
            host,
            ccid: this.ccid,
            privatekey,
            client
        })
    }

    static async create(privatekey: string, host: FQDN, client?: string): Promise<Client> {
        const c = new Client(privatekey, host, client)
        const user = await c.getUser(c.ccid)
        if (!user) throw new Error('user not found')
        c.user = user
        return c
    }

    async getUser(id: CCID): Promise<User | null> {
        return await User.load(this, id)
    }

    async getStream<T>(id: StreamID): Promise<Stream<T> | null> {
        return await Stream.load(this, id)
    }

    async getAssociation<T>(id: AssociationID, owner: CCID): Promise<Association<T> | null | undefined> {
        return await Association.load(this, id, owner)
    }

    async getMessage<T>(id: MessageID, authorID: CCID): Promise<Message<T> | null | undefined> {
        return await Message.load(this, id, authorID)
    }

    async createCurrent(body: string, streams: StreamID[], emojis: Record<string, {imageURL?: string, animURL?: string}> = {}, profileOverride: ProfileOverride = {}): Promise<Error | null> {
        return await this.api.createMessage<SimpleNote>(Schemas.simpleNote, {body, emojis, profileOverride}, streams)
    }

    async setupUserstreams(): Promise<void> {
        const userstreams: CoreCharacter<Userstreams> | null | undefined = await this.api.readCharacter(this.ccid, Schemas.userstreams)
        const id = userstreams?.id
        let homeStream = userstreams?.payload.body.homeStream
        if (!homeStream) {
            const res0 = await this.api.createStream(Schemas.utilitystream, {}, { writer: [this.ccid] })
            homeStream = res0.id
            console.log('home', homeStream)
        }

        let notificationStream = userstreams?.payload.body.notificationStream
        if (!notificationStream) {
            const res1 = await this.api.createStream(Schemas.utilitystream, {}, {})
            notificationStream = res1.id
            console.log('notification', notificationStream)
        }

        let associationStream = userstreams?.payload.body.associationStream
        if (!associationStream) {
            const res2 = await this.api.createStream(Schemas.utilitystream, {}, { writer: [this.ccid] })
            associationStream = res2.id
            console.log('association', associationStream)
        }

        let ackCollection = userstreams?.payload.body.ackCollection
        if (!ackCollection) {
            const res3 = await this.api.createCollection(Schemas.userAckCollection, true, {})
            ackCollection = res3.id
            console.log('ack', ackCollection)
        }

        this.api.upsertCharacter<Userstreams>(
            Schemas.userstreams,
            {
                homeStream,
                notificationStream,
                associationStream,
                ackCollection
            },
            id
        ).then((data) => {
            console.log(data)
        })
    }

    async ackUser(user: User): Promise<void> {
        if (!user.profile || !user.userstreams) return
        const collectionID = this.user?.userstreams?.payload.body.ackCollection
        if (!collectionID) return

        const targetStream = [user.userstreams?.payload.body.notificationStream, this.user?.userstreams?.payload.body.associationStream].filter((e) => e) as string[]
        const association = await this.api.createAssociation<UserAck>(Schemas.userAck, {}, user.profile.id, user.ccid, 'characters', targetStream)
        console.log('createdAssociation', association)
        console.log('id', association.content.id)

        await this.api.addCollectionItem<UserAckCollection>(collectionID, {
            ccid: user.ccid,
            association: association.content.id
        })
    }

    async unAckUser(itemID: CollectionItemID): Promise<void> {
        const collectionID = this.user?.userstreams?.payload.body.ackCollection
        if (!collectionID) return

        const deleted = await this.api.deleteCollectionItem<UserAckCollection>(collectionID, itemID)
        console.log('deleted', deleted)
        if (!deleted || !deleted.payload.association || !deleted.payload.ccid) return
        console.log('deletedAssociation', deleted.payload.association)
        const { content } = await this.api.deleteAssociation(deleted.payload.association, deleted.payload.ccid)
        console.log('deletedAssociationContent', content)
        this.api.invalidateCharacter(content.targetID)
    }

    async getCommonStreams(remote: FQDN): Promise<Stream<Commonstream>[]> {
        const streams = await this.api.getStreamListBySchema(Schemas.commonstream, remote)
        return streams.map((e) => { return {
            id: e.id,
            schema: e.schema,
            author: e.author,
            maintainer: e.maintainer,
            writer: e.writer,
            reader: e.reader,
            cdate: new Date(e.cdate),
            ...e.payload,
        }})
    }

    async createCommonStream(name: string, description: string): Promise<void> {
        await this.api.createStream<Commonstream>(Schemas.commonstream, {
            name,
            shortname: name,
            description
        })
    }

    async createProfile(username: string, description: string, avatar: string, banner: string): Promise<Profile> {
        return await this.api.upsertCharacter<Profile>(Schemas.profile, {
            username,
            description,
            avatar,
            banner
        })
    }

    async updateProfile(id: string, username: string, description: string, avatar: string, banner: string): Promise<Profile> {
        return await this.api.upsertCharacter<Profile>(Schemas.profile, {
            username,
            description,
            avatar,
            banner
        }, id)
    }

    async newSocket(): Promise<Socket> {
        if (!this.socket) {
            this.socket = new Socket(this.api)
            await this.socket.waitOpen()
        }
        return this.socket!
    }

    async newTimeline(): Promise<Timeline> {
        const socket = await this.newSocket()
        return new Timeline(this.api, socket)
    }

    async newSubscription(): Promise<Subscription> {
        const socket = await this.newSocket()
        return new Subscription(socket)
    }
}

export class User implements CoreEntity {

    api: Api
    client: Client

    ccid: CCID
    tag: string
    domain: FQDN 
    cdate: string
    score: number
    certs: Certificate[]

    profile?: CoreCharacter<Profile>
    userstreams?: CoreCharacter<Userstreams>

    constructor(client: Client,
                data: CoreEntity,
                profile?: CoreCharacter<Profile>,
                userstreams?: CoreCharacter<Userstreams>) {
        this.api = client.api
        this.client = client
        this.ccid = data.ccid
        this.tag = data.tag
        this.domain = data.domain
        this.cdate = data.cdate
        this.score = data.score
        this.certs = data.certs
        this.profile = profile
        this.userstreams = userstreams
    }

    static async load(client: Client, id: CCID): Promise<User | null> {
        const entity = await client.api.readEntity(id).catch((e) => {
            console.log('CLIENT::getUser::readEntity::error', e)
            return null
        })
        if (!entity) return null

        const profile: CoreCharacter<Profile> | undefined = await client.api.readCharacter<Profile>(id, Schemas.profile) ?? undefined
        const userstreams: CoreCharacter<Userstreams> | undefined = await client.api.readCharacter<Userstreams>(id, Schemas.userstreams) ?? undefined

        return new User(client, entity, profile, userstreams)
    }

    async getAcking(): Promise<User[]> {
        const acks = await this.api.getAcking(this.ccid)
        const users = await Promise.all(acks.map((e) => User.load(this.client, e.to)))
        return users.filter((e) => e !== null) as User[]
    }

    async getAcker(): Promise<User[]> {
        const acks = await this.api.getAcker(this.ccid)
        const users = await Promise.all(acks.map((e) => User.load(this.client, e.from)))
        return users.filter((e) => e !== null) as User[]
    }

    async Ack(): Promise<void> {
        await this.api.ack(this.ccid)
    }

    async UnAck(): Promise<void> {
        await this.api.unack(this.ccid)
    }


}

export class Association<T> implements CoreAssociation<T> {
    api: Api
    client: Client

    author: CCID
    cdate: string
    id: AssociationID
    payload: SignedObject<T>
    rawpayload: string
    schema: Schema
    signature: string
    targetID: MessageID
    targetType: 'messages' | 'characters'

    owner?: CCID

    authorUser?: User

    constructor(client: Client, data: CoreAssociation<T>) {
        this.api = client.api
        this.client = client
        this.author = data.author
        this.cdate = data.cdate
        this.id = data.id
        this.payload = data.payload
        this.rawpayload = data.rawpayload
        this.schema = data.schema
        this.signature = data.signature
        this.targetID = data.targetID
        this.targetType = data.targetType
    }

    static async load<T>(client: Client, id: AssociationID, owner: CCID): Promise<Association<T> | null> {
        const coreAss = await client.api.readAssociationWithOwner(id, owner).catch((e) => {
            console.log('CLIENT::getAssociation::readAssociationWithOwner::error', e)
            return null
        })
        if (!coreAss) return null

        const association = new Association<T>(client, coreAss)
        association.authorUser = await client.getUser(association.author) ?? undefined

        association.owner = owner

        return association
    }

    static async loadByBody<T>(client: Client, body: CoreAssociation<T>): Promise<Association<T> | null> {
        const association = new Association<T>(client, body)
        association.authorUser = await client.getUser(association.author) ?? undefined

        return association
    }

    async getAuthor(): Promise<User> {
        const author = await this.client.getUser(this.author)
        if (!author) throw new Error('author not found')
        return author
    }

    async getTargetMessage(): Promise<Message<any>> {
        if (this.targetType !== 'messages') throw new Error(`target is not message (actual: ${this.targetType})`)
        if (!this.owner) throw new Error('owner is not set')
        const message = await this.client.getMessage(this.targetID, this.owner)
        if (!message) throw new Error('target message not found')
        return message
    }

    async delete(): Promise<void> {
        const { content } = await this.api.deleteAssociation(this.id, this.author)
        this.api.invalidateMessage(content.targetID)
    }
}

export class Stream<T> implements CoreStream<T> {

    api: Api
    client: Client

    id: StreamID
    visible: boolean
    author: CCID
    maintainer: CCID[]
    writer: CCID[]
    reader: CCID[]
    schema: CCID
    payload: T
    cdate: string

    constructor(client: Client, data: CoreStream<T>) {
        this.api = client.api
        this.client = client

        this.id = data.id
        this.visible = data.visible
        this.author = data.author
        this.maintainer = data.maintainer
        this.writer = data.writer
        this.reader = data.reader
        this.schema = data.schema
        this.payload = data.payload
        this.cdate = data.cdate
    }

    static async load<T>(client: Client, id: StreamID): Promise<Stream<T> | null> {
        const stream = await client.api.readStream(id).catch((e) => {
            console.log('CLIENT::getStream::readStream::error', e)
            return null
        })
        if (!stream) return null

        return new Stream<T>(client, stream)
    }

}

export class Message<T> implements CoreMessage<T> {

    api: Api
    user: User
    client: Client
    associations: Array<CoreAssociation<any>>
    ownAssociations: Array<CoreAssociation<any>>
    author: CCID
    cdate: string
    id: MessageID
    payload: SignedObject<T>
    rawpayload: string
    schema: Schema
    signature: string
    streams: StreamID[]

    associationCounts?: Record<string, number>
    reactionCounts?: Record<string, number>
    postedStreams?: Stream<any>[]

    authorUser?: User

    constructor(client: Client, data: CoreMessage<T>) {
        this.api = client.api
        this.user = client.user!
        this.client = client
        this.associations = data.associations ?? []
        this.ownAssociations = data.ownAssociations ?? []
        this.author = data.author
        this.cdate = data.cdate
        this.id = data.id
        this.payload = data.payload
        this.rawpayload = data.rawpayload
        this.schema = data.schema
        this.signature = data.signature
        this.streams = data.streams
    }

    static async load<T>(client: Client, id: MessageID, authorID: CCID): Promise<Message<T> | null> {
        const coreMsg = await client.api.readMessageWithAuthor(id, authorID).catch((e) => {
            console.log('CLIENT::getMessage::readMessageWithAuthor::error', e)
            return null
        })
        if (!coreMsg) return null

        const message = new Message(client, coreMsg)

        message.authorUser = await client.getUser(authorID) ?? undefined
        try {
            message.associationCounts = await client.api.getMessageAssociationCountsByTarget(id, authorID)
            message.reactionCounts = await client.api.getMessageAssociationCountsByTarget(id, authorID, {schema: Schemas.emojiAssociation})
        } catch (e) {
            console.log('CLIENT::getMessage::error', e)
        }

        const streams = await Promise.all(
            message.streams.map((e) => client.getStream(e))
        )
        message.postedStreams = streams.filter((e) => e) as Stream<any>[]

        return message
    }

    async getAuthor(): Promise<User> {
        const author = await this.client.getUser(this.author)
        if (!author) {
            throw new Error('Author not found')
        }
        return author
    }

    async getStreams<T>() : Promise<Stream<T>[]> {
        const streams = await Promise.all(this.streams.map((e) => this.client.getStream(e)))
        return streams.filter((e) => e) as Stream<T>[]
    }

    async getReplies(): Promise<Association<ReplyAssociation>[]> {
        const coreass = await this.client.api.getMessageAssociationsByTarget(this.id, this.author, {schema: Schemas.replyAssociation})
        return coreass.map((e) => new Association<ReplyAssociation>(this.client, e))
    }

    async getReroutes(): Promise<Association<RerouteAssociation>[]> {
        const coreass = await this.client.api.getMessageAssociationsByTarget(this.id, this.author, {schema: Schemas.rerouteAssociation})
        return coreass.map((e) => new Association<RerouteAssociation>(this.client, e))
    }

    async getFavorites(): Promise<Association<Like>[]> {
        const coreass = await this.client.api.getMessageAssociationsByTarget(this.id, this.author, {schema: Schemas.like})
        return coreass.map((e) => new Association<Like>(this.client, e))
    }

    async getReactions(imgUrl: string): Promise<Association<EmojiAssociation>[]> {
        const coreass = await this.client.api.getMessageAssociationsByTarget(this.id, this.author, {schema: Schemas.emojiAssociation, variant: imgUrl})
        const ass: Array<Association<EmojiAssociation> | null> = await Promise.all(coreass.map((e) => Association.loadByBody<EmojiAssociation>(this.client, e)))

        return ass.filter(e => e) as Array<Association<EmojiAssociation>>
    }

    async getReplyTo(): Promise<Message<ReplyMessage> | null> {
        if (this.schema != Schemas.replyMessage) {
            throw new Error('This message is not a reply')
        }
        const replyPayload = this.payload.body as ReplyMessage
        return await Message.load<ReplyMessage>(this.client, replyPayload.replyToMessageId, replyPayload.replyToMessageAuthor)
    }

    async GetRerouteTo(): Promise<Message<RerouteMessage> | null> {
        if (this.schema != Schemas.rerouteMessage) {
            throw new Error('This message is not a reroute')
        }
        const reroutePayload = this.payload.body as RerouteMessage
        return await Message.load<RerouteMessage>(this.client, reroutePayload.rerouteMessageId, reroutePayload.rerouteMessageAuthor)
    }

    async favorite() {
        const author = await this.getAuthor()
        const targetStream = [author.userstreams?.payload.body.notificationStream, this.client.user?.userstreams?.payload.body.associationStream].filter((e) => e) as string[]
        await this.api.createAssociation<Like>(Schemas.like, {}, this.id, author.ccid, 'messages', targetStream)
        this.api.invalidateMessage(this.id)
    }

    async reaction(shortcode: string, imageUrl: string) {
        const author = await this.getAuthor()
        const targetStream = [author.userstreams?.payload.body.notificationStream, this.client.user?.userstreams?.payload.body.associationStream].filter((e) => e) as string[]
        await this.client.api.createAssociation<EmojiAssociation>(
            Schemas.emojiAssociation,
            {
                shortcode,
                imageUrl
            },
            this.id,
            author.ccid,
            'messages',
            targetStream,
            imageUrl
        )
        this.api.invalidateMessage(this.id)
    }

    async deleteAssociation(associationID: string) {
        const { content } = await this.api.deleteAssociation(associationID, this.author)
        this.api.invalidateMessage(content.targetID)
    }

    async reply(streams: string[], body: string, emojis?: Record<string, {imageURL?: string, animURL?: string}>) {
        const data = await this.api.createMessage<ReplyMessage>(
          Schemas.replyMessage,
          {
              replyToMessageId: this.id,
              replyToMessageAuthor: this.author,
              body,
              emojis
          },
          streams
        )

        const author = await this.getAuthor()
        const targetStream = [author.userstreams?.payload.body.notificationStream, this.user.userstreams?.payload.body.associationStream].filter((e) => e) as string[]

        await this.api.createAssociation<ReplyAssociation>(
          Schemas.replyAssociation,
          { messageId: data.content.id, messageAuthor: this.user.ccid },
          this.id,
          this.author,
          'messages',
          targetStream || []
        )
    }

    async reroute(streams: string[], body?: string, emojis?: Record<string, {imageURL?: string, animURL?: string}>) {
        const { content } = await this.api.createMessage<RerouteMessage>(
            Schemas.rerouteMessage,
            {
                body,
                emojis,
                rerouteMessageId: this.id,
                rerouteMessageAuthor: this.author
            },
            streams
        )
        const created = content

        const author = await this.getAuthor()
        const targetStream = [author.userstreams?.payload.body.notificationStream, this.user.userstreams?.payload.body.associationStream].filter((e) => e) as string[]

        await this.api.createAssociation<RerouteAssociation>(
            Schemas.rerouteAssociation,
            { messageId: created.id, messageAuthor: created.author },
            this.id,
            this.author,
            'messages',
            targetStream
        )
    }

    async delete() {
        return this.api.deleteMessage(this.id)
    }
}

