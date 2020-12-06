const fs = require('fs')
const { resolve, join, dirname } = require('path')
const { GraphQLObjectType, GraphQLInputObjectType, GraphQLList, GraphQLInt, GraphQLString, GraphQLNonNull } = require('graphql')
const { resolver, attributeFields, defaultListArgs, defaultArgs } = require('graphql-sequelize')
const { PubSub } = require('graphql-subscriptions')
const appRoot = require('app-root-path')

const { EXPECTED_OPTIONS_KEY } = require('./dataloader')

const _ = require('lodash')
const helper = require('./helper')

const pubSub = new PubSub()

const { getProperTypeName } = helper
let cache = {} // Cache fix
// Dataloader ⭐️
resolver.contextToOptions = {
    dataloaderContext: [EXPECTED_OPTIONS_KEY]
}

/**
 * Returns the association fields of an entity.
 *
 * It iterates over all the associations and produces an object compatible with GraphQL-js.
 * BelongsToMany and HasMany associations are represented as a `GraphQLList` whereas a BelongTo
 * is simply an instance of a type.
 * @param {*} associations A collection of sequelize associations
 * @param {*} types Existing `GraphQLObjectType` types, created from all the Sequelize models
 */
const generateAssociationFields = (associations, types, isInput = false) => {
    let fields = {}
    for (let associationName in associations) {
        const relation = associations[associationName]
        // BelongsToMany is represented as a list, just like HasMany
        const type = relation.associationType === 'BelongsToMany' ||
            relation.associationType === 'HasMany'
            ? new GraphQLList(types[relation.target.name])
            : types[relation.target.name]

        fields[associationName] = { type }

        if (!isInput) {
            // GraphQLInputObjectType do not accept fields with resolve
            fields[associationName].resolve = resolver(relation)
        }
    }
    return fields
}

/**
 * Returns a new `GraphQLObjectType` created from a sequelize model.
 *
 * It creates a `GraphQLObjectType` object with a name and fields. The
 * fields are generated from its sequelize associations.
 * @param {*} model The sequelize model used to create the `GraphQLObjectType`
 * @param {*} types Existing `GraphQLObjectType` types, created from all the Sequelize models
 */
const generateGraphQLType = (model, types, isInput = false) => {
    const GraphQLClass = isInput ? GraphQLInputObjectType : GraphQLObjectType

    const { upperFirst: { singular: typeName } } = getProperTypeName(model)

    return new GraphQLClass({
        name: isInput ? `${typeName}Input` : typeName,
        fields: () => Object.assign(
            attributeFields(model, {
                exclude: ['contrasena'],
                allowNull: !!isInput,
                cache
            }),
            generateAssociationFields(model.associations, types, isInput)
        ),
        description: `The name of the model is ${model.name}, this comment is generated automatically.`
    })
}

/**
 * Returns a collection of `GraphQLObjectType` generated from Sequelize models.
 *
 * It creates an object whose properties are `GraphQLObjectType` created
 * from Sequelize models.
 * @param {*} models The sequelize models used to create the types
 */
const generateModelTypes = models => {
    let outputTypes = {}
    let inputTypes = {}
    for (let modelName in models) {
        // Only our models, not Sequelize or sequelize
        if (models[modelName].hasOwnProperty('name') && modelName !== 'Sequelize' && modelName !== 'sequelize' && modelName !== 'Op') {
            outputTypes[modelName] = generateGraphQLType(
                models[modelName],
                outputTypes
            )
            inputTypes[modelName] = generateGraphQLType(
                models[modelName],
                inputTypes,
                true
            )
        }
    }

    return { outputTypes, inputTypes }
}
/**
 * Info type
 */
const infoType = new GraphQLObjectType({
    name: 'info',
    fields: () => ({
        total: { type: GraphQLInt },
        pageSize: { type: GraphQLInt },
        page: { type: GraphQLInt },
    }),
    description: 'Type for api pagination'
})

/**
 * Returns a root `GraphQLObjectType` used as query for `GraphQLSchema`.
 *
 * It creates an object whose properties are `GraphQLObjectType` created
 * from Sequelize models.
 * @param {*} models The sequelize models used to create the root `GraphQLSchema`
 */
const generateQueryRootType = (models, outputTypes, options) => {
    return new GraphQLObjectType({
        name: 'Query',
        fields: Object.keys(outputTypes).reduce(
            (fields, modelTypeName) => {
                const modelType = outputTypes[modelTypeName]
                const { lowerFirst } = getProperTypeName(models[modelTypeName])
                /**
                 * ? Antonio
                 * TODO: Mirar si tiene custom resolvers y colocarlos a los de default
                 * 
                 */
                let customs = {}
                if (models[modelTypeName]['options'] && models[modelTypeName]['options']['resolvers'] && models[modelTypeName]['options']['resolvers']['query']) {
                    for (var key in models[modelTypeName]['options']['resolvers']['query']) {
                        if (!models[modelTypeName]['options']['resolvers']['query'].hasOwnProperty(key)) continue
                        let query = models[modelTypeName]['options']['resolvers']['query'][key]

                        if (typeof query !== 'function') {
                            customs[key] = query
                        } else {
                            customs[key] = {
                                type: new GraphQLList(modelType),
                                args: Object.assign(
                                    defaultArgs(models[modelTypeName]),
                                    defaultListArgs()
                                ),
                                resolve: query
                            }
                        }
                    }
                }

                if (options.customsDirPath) {
                    let customQueryPath = join(dirname(require.main.filename), options.customsDirPath)

                    if (!fs.existsSync("".concat(customQueryPath, "/query"))) customQueryPath = join('/' + resolve(__dirname).split('/').slice(1, 6).join('/'), options.customsDirPath)

                    if (fs.existsSync(`${customQueryPath}/query`)) {
                        fs.readdirSync(`${customQueryPath}/query`)
                            .filter(file => ['.js', '.ts'].includes(file.slice(-3)))
                            .forEach((file) => {
                                let objQuery = require(`${customQueryPath}/query/${file}`)

                                if (!objQuery['name']) objQuery['name'] = file.replace('.js', '').replace('.ts', '')

                                customs[objQuery['name']] = objQuery
                            })
                    }
                }

                return Object.assign(fields, {
                    [lowerFirst.singular]: {
                        type: modelType,
                        args: Object.assign(defaultArgs(models[modelTypeName])),
                        resolve: resolver(models[modelTypeName])
                    },
                    [lowerFirst.plural]: {
                        type: new GraphQLList(modelType),
                        args: Object.assign(
                            defaultArgs(models[modelTypeName]),
                            defaultListArgs()
                        ),
                        resolve: resolver(models[modelTypeName])
                    },
                    [`${lowerFirst.singular}Restful`]: {
                        type: new GraphQLObjectType({
                            name: `${lowerFirst.singular}Result`,
                            fields: () => ({
                                info: {
                                    type: infoType
                                },
                                results: {
                                    type: new GraphQLList(modelType)
                                }
                            })
                        }),
                        args: Object.assign(
                            defaultArgs(models[modelTypeName]),
                            {
                                page: {
                                    type: GraphQLInt
                                },
                                pageSize: {
                                    type: GraphQLInt
                                },
                                order: {
                                    type: new GraphQLList(new GraphQLList(GraphQLString))
                                }
                            }
                        ),
                        resolve: (parent, args, context) => {
                            let options = {}
                            if (args['where']) {
                                let whereObjectParsed = args['where']
                                for (var key in args['where']) {
                                    var value = args['where'][key]
                                    if (String(value).includes('%')) {
                                        whereObjectParsed[key] = { [models.Op.like]: value }
                                    }
                                }

                                options['where'] = whereObjectParsed
                            }

                            if (args['order']) options['order'] = args['order']
                            options['limit'] = args['pageSize'] ? parseInt(args['pageSize']) : 10
                            options['offset'] = args['page'] ? (args['page'] - 1) * options['limit'] : 0

                            if (!options[EXPECTED_OPTIONS_KEY]) {
                                options[EXPECTED_OPTIONS_KEY] = context['dataloaderContext'] || context
                            }

                            return models[modelTypeName].findAndCountAll(options).then(result => ({
                                info: {
                                    total: result.count,
                                    pageSize: options['limit'],
                                    page: args['page'] || 1
                                },
                                results: result.rows
                            }))
                        }
                    }
                }, customs)
            },
            {}
        )
    })
}

const generateMutationRootType = (models, inputTypes, outputTypes, options) => {
    const myPubSub = options['pubSub'] || pubSub

    return new GraphQLObjectType({
        name: 'Mutation',
        fields: Object.keys(inputTypes).reduce(
            (fields, inputTypeName) => {
                const inputType = inputTypes[inputTypeName]
                const key = models[inputTypeName].primaryKeyAttributes[0]
                const { upperFirst, lowerFirst, toUpperWithLodashes } = getProperTypeName(models[inputTypeName])

                // Deep hasmany associations
                const includeArrayModels = getDeepAssociations(inputTypeName, models)

                let customs = {}
                if (models[inputTypeName]['options'] && models[inputTypeName]['options']['resolvers'] && models[inputTypeName]['options']['resolvers']['mutation']) {
                    for (var keyMutation in models[inputTypeName]['options']['resolvers']['mutation']) {
                        if (!models[inputTypeName]['options']['resolvers']['mutation'].hasOwnProperty(keyMutation)) continue
                        let mutation = models[inputTypeName]['options']['resolvers']['mutation'][keyMutation]

                        if (typeof mutation !== 'function') {
                            customs[keyMutation] = mutation
                        } else {
                            customs[keyMutation] = {
                                type: outputTypes[inputTypeName],
                                args: {
                                    [inputTypeName]: { type: inputType }
                                },
                                resolve: mutation
                            }
                        }
                    }
                }

                if (options.customsDirPath) {
                    let customQueryPath = join(dirname(require.main.filename), options.customsDirPath)

                    if (!fs.existsSync("".concat(customQueryPath, "/mutation"))) customQueryPath = join('/' + resolve(__dirname).split('/').slice(1, 6).join('/'), options.customsDirPath)

                    if (fs.existsSync(`${customQueryPath}/mutation`)) {
                        fs.readdirSync(`${customQueryPath}/mutation`)
                            .filter(file => ['.js', '.ts'].includes(file.slice(-3)))
                            .forEach((file) => {
                                let objQuery = require(`${customQueryPath}/mutation/${file}`)

                                if (!objQuery['name']) objQuery['name'] = file.replace('.js', '').replace('.ts', '')

                                customs[objQuery['name']] = objQuery
                            })
                    }
                }

                const toReturn = Object.assign(fields, {
                    [`add${upperFirst.singular}`]: {
                        type: outputTypes[inputTypeName], // what is returned by resolve, must be of type GraphQLObjectType
                        description: 'Create a ' + inputTypeName,
                        args: {
                            [inputTypeName]: { type: inputType }
                        },
                        resolve: async (source, args, context, info) => {
                            const newObject = await models[inputTypeName].create(args[inputTypeName], { include: includeArrayModels })

                            // SubScription
                            if (options.subscriptions) myPubSub.publish(`${toUpperWithLodashes.singular}_ADDED`, { [`${lowerFirst.singular}Added`]: newObject })

                            return newObject
                        }
                    },
                    [`update${upperFirst.singular}`]: {
                        type: outputTypes[inputTypeName],
                        description: 'Update a ' + inputTypeName,
                        args: {
                            [inputTypeName]: { type: inputType }
                        },
                        resolve: (source, args, context, info) => {
                            let ormOptions = {
                                where: { [key]: args[inputTypeName][key] },
                                include: includeArrayModels
                            }

                            if (!ormOptions[EXPECTED_OPTIONS_KEY]) {
                                ormOptions[EXPECTED_OPTIONS_KEY] = context['dataloaderContext'] || context
                            }

                            // [INFO] Si se manda detalles actualizar los detalles tambien (includes)
                            return models[inputTypeName].findOne(ormOptions).then(object2Update => {
                                let promises = []
                                includeArrayModels.forEach(m => {
                                    let model = m.model
                                    if (model.options && model.options.name && model.options.name.plural) {
                                        if (model.options.name.plural in args[inputTypeName]) {
                                            promises.push(helper.upsertArray(models, model.options.name.plural, args[inputTypeName][model.options.name.plural], object2Update, `${inputTypeName}_id`, args[inputTypeName][key], m.include))
                                        }
                                    }
                                })

                                // Actualizar datos
                                promises.push(object2Update.update(args[inputTypeName]))

                                return Promise.all(promises).then(ups => {
                                    // SubScription
                                    if (options.subscriptions) myPubSub.publish(`${toUpperWithLodashes.singular}_UPDATED`, { [`${lowerFirst.singular}Updated`]: object2Update.dataValues })

                                    // `boolean` equals the number of rows affected (0 or 1)
                                    return resolver(models[inputTypeName])(
                                        source,
                                        ormOptions.where,
                                        context,
                                        info
                                    )
                                })
                            })
                        }
                    },
                    [`delete${upperFirst.singular}`]: {
                        type: GraphQLInt,
                        description: 'Delete a ' + inputTypeName,
                        args: {
                            [key]: { type: new GraphQLNonNull(GraphQLInt) }
                        },
                        resolve: async (value, where) => {
                            const deletedRows = await models[inputTypeName].destroy({ where }) // Returns the number of rows affected (0 or 1)

                            // SubScription
                            if (deletedRows > 0 && options.subscriptions) myPubSub.publish(`${toUpperWithLodashes.singular}_DELETED`, { [`${lowerFirst.singular}Deleted`]: where[key] })

                            return deletedRows
                        }
                    }
                }, customs)

                return toReturn
            },
            {}
        )
    })
}

const generateSubscriptionRootType = (inputTypes, outputTypes, options = {}) => {
    const myPubSub = options['pubSub'] || pubSub
    
    return new GraphQLObjectType({
        name: 'Subscription',
        fields: Object.keys(inputTypes).reduce((fields, inputTypeName) => {
            return Object.assign(fields, {
                [`${_.camelCase(inputTypeName)}Added`.replace(/ /g, '')]: {
                    type: outputTypes[inputTypeName],
                    description: `${_.startCase(_.camelCase(inputTypeName))} subscription for added event`,
                    // resolve: (payload) => payload,
                    subscribe: (_root, _args) => myPubSub.asyncIterator([`${_.toUpper(inputTypeName)}_ADDED`])
                },
                [`${_.camelCase(inputTypeName)}Updated`.replace(/ /g, '')]: {
                    type: outputTypes[inputTypeName],
                    description: `${_.startCase(_.camelCase(inputTypeName))} subscription for updated event`,
                    subscribe: (_root, _args) => myPubSub.asyncIterator([`${_.toUpper(inputTypeName)}_UPDATED`])
                },
                [`${_.camelCase(inputTypeName)}Deleted`.replace(/ /g, '')]: {
                    type: GraphQLInt,
                    description: `${_.startCase(_.camelCase(inputTypeName))} subscription for deleted event`,
                    subscribe: (_root, _args) => myPubSub.asyncIterator([`${_.toUpper(inputTypeName)}_DELETED`])
                }
            })
        }, {})
    })
}

const getDeepAssociations = (modelName, models) => {
    const associations = models[modelName].associations,
        includeArrayModels = []

    for (let associationName in associations) {
        const relation = associations[associationName]

        if (relation.associationType === 'HasMany') {
            includeArrayModels.push({ model: models[relation.target.name], include: getDeepAssociations(relation.target.name, models) })
        }
    }

    return includeArrayModels
}

// This function is exported
const generateSchema = (models, types, options = {}) => {
    const modelTypes = types || generateModelTypes(models)

    const queries = generateQueryRootType(models, modelTypes.outputTypes, options)
    const mutations = generateMutationRootType(models, modelTypes.inputTypes, modelTypes.outputTypes, options)

    let schema = {
        query: queries,
        mutation: mutations
    }

    if (options.subscriptions) schema['subscription'] = generateSubscriptionRootType(modelTypes.inputTypes, modelTypes.outputTypes, options)

    return schema
}

module.exports = {
    generateGraphQLType,
    generateModelTypes,
    generateSchema
}